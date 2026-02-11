const express = require("express");
const router = express.Router();
const { pool } = require("../supabaseAdmin");
const authMiddleware = require("./middleware/auth");

const TAFSILI_TABLE = "accounting_tafsili";

// ============================================================
// Helpers
// ============================================================

const isUUID = (s) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s || ""));

const toUUID = (id) => {
  if (id === undefined || id === null || id === "") return null;
  const s = String(id).trim();
  if (isUUID(s)) return s;
  if (/^\d+$/.test(s)) return `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
  return s; // اگر چیز دیگری بود همان را برگردان تا در validate گیر کنیم
};

function logQuery(label, sql, params) {
  const safeParams = (params || []).map((v) => {
    if (v === null || v === undefined) return v;
    const s = String(v);
    if (s.length > 80) return `${s.slice(0, 80)}…`;
    return v;
  });
  console.log(`🧩 [${label}] SQL:\n${sql.trim()}`);
  console.log(`🧩 [${label}] PARAMS:`, safeParams);
}

function getMemberIdFromReq(req) {
  // به ترتیب اولویت
  const raw =
    req?.user?.member_id ??
    req?.user?.memberId ??
    req?.user?.member ??
    req?.headers?.["x-member-id"] ??
    null;

  const memberId = toUUID(raw);
  if (!memberId || !isUUID(memberId)) return null;
  return memberId;
}

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

async function generateNextTafsiliCode(memberId, client) {
  try {
    const sql = `
      SELECT COALESCE(MAX(code::int), 0) AS max_code
      FROM ${TAFSILI_TABLE}
      WHERE member_id = $1
        AND tafsili_type = 'customer'
        AND code ~ '^[0-9]+$'
    `;
    const res = await client.query(sql, [memberId]);
    const max = Number(res.rows[0]?.max_code || 0);
    return String(max + 1).padStart(4, "0");
  } catch (e) {
    console.error("❌ Code Gen Error:", e.message);
    return "0001";
  }
}

// ============================================================
// Routes
// ============================================================

// 1) لیست مشتریان
router.get(
  "/",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const member_id = getMemberIdFromReq(req);
    if (!member_id) {
      return res.status(401).json({
        success: false,
        error: "member_id معتبر در توکن یافت نشد",
      });
    }

    const { search } = req.query;

    let sql = `
      SELECT *
      FROM public.customers
      WHERE member_id = $1
    `;
    const params = [member_id];

    if (search && String(search).trim()) {
      sql += ` AND (name ILIKE $2 OR mobile ILIKE $2 OR national_id ILIKE $2)`;
      params.push(`%${String(search).trim()}%`);
    }

    sql += ` ORDER BY created_at DESC LIMIT 500`;

    logQuery("GET /customers", sql, params);
    const { rows } = await pool.query(sql, params);

    return res.status(200).json({
      success: true,
      data: rows || [],
      count: (rows || []).length,
    });
  })
);

// 2) دریافت مشتری تکی
router.get(
  "/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const member_id = getMemberIdFromReq(req);
    if (!member_id) {
      return res.status(401).json({ success: false, error: "member_id معتبر نیست" });
    }

    const id = req.params.id;
    if (!id) {
      return res.status(400).json({ success: false, error: "id الزامی است" });
    }

    const sql = `SELECT * FROM public.customers WHERE id = $1 AND member_id = $2`;
    const { rows } = await pool.query(sql, [id, member_id]);

    if (!rows.length) {
      return res.status(404).json({ success: false, error: "مشتری یافت نشد" });
    }

    return res.json({ success: true, data: rows[0] });
  })
);

// 3) ثبت مشتری جدید + ایجاد تفصیلی
router.post(
  "/",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const client = await pool.connect();
    try {
      const member_id = getMemberIdFromReq(req);
      if (!member_id) {
        return res.status(401).json({ success: false, error: "member_id معتبر نیست" });
      }

      const { name, mobile, national_id, address, customer_type, birth_or_register_date } = req.body || {};

      if (!name || !String(name).trim()) {
        return res.status(400).json({ success: false, error: "نام مشتری الزامی است" });
      }

      await client.query("BEGIN");

      // چک تکراری موبایل
      if (mobile) {
        const check = await client.query(
          "SELECT id FROM public.customers WHERE mobile = $1 AND member_id = $2 LIMIT 1",
          [mobile, member_id]
        );
        if (check.rows.length > 0) {
          await client.query("ROLLBACK");
          return res.status(400).json({ success: false, error: "این شماره موبایل قبلاً ثبت شده است" });
        }
      }

      const insertCustomerSql = `
        INSERT INTO public.customers
          (member_id, name, mobile, national_id, address, customer_type, birth_or_register_date, created_at, updated_at)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
        RETURNING *
      `;
      const customerRes = await client.query(insertCustomerSql, [
        member_id,
        String(name).trim(),
        mobile || null,
        national_id || null,
        address || null,
        customer_type || "real",
        birth_or_register_date || null,
      ]);
      const newCustomer = customerRes.rows[0];

      const nextCode = await generateNextTafsiliCode(member_id, client);
      const insertTafsiliSql = `
        INSERT INTO ${TAFSILI_TABLE}
          (member_id, code, title, tafsili_type, ref_id, is_active, created_at)
        VALUES
          ($1, $2, $3, 'customer', $4, true, NOW())
        RETURNING id
      `;
      const tafsiliRes = await client.query(insertTafsiliSql, [member_id, nextCode, String(name).trim(), newCustomer.id]);

      await client.query("UPDATE public.customers SET tafsili_id = $1 WHERE id = $2", [
        tafsiliRes.rows[0].id,
        newCustomer.id,
      ]);

      await client.query("COMMIT");
      return res.json({ success: true, data: newCustomer, message: "مشتری با موفقیت ایجاد شد" });
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("❌ Create Customer Error:", e);
      return res.status(500).json({ success: false, error: "خطا در ثبت مشتری", detail: e.message });
    } finally {
      client.release();
    }
  })
);

// 4) ویرایش مشتری
router.put(
  "/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const client = await pool.connect();
    try {
      const member_id = getMemberIdFromReq(req);
      if (!member_id) {
        return res.status(401).json({ success: false, error: "member_id معتبر نیست" });
      }

      const id = req.params.id;
      const { name, mobile, national_id, address, customer_type, birth_or_register_date } = req.body || {};

      await client.query("BEGIN");

      const checkRes = await client.query(
        "SELECT * FROM public.customers WHERE id = $1 AND member_id = $2 LIMIT 1",
        [id, member_id]
      );
      if (!checkRes.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ success: false, error: "مشتری یافت نشد" });
      }
      const currentCustomer = checkRes.rows[0];

      if (mobile) {
        const dupRes = await client.query(
          "SELECT id FROM public.customers WHERE mobile = $1 AND member_id = $2 AND id <> $3 LIMIT 1",
          [mobile, member_id, id]
        );
        if (dupRes.rows.length) {
          await client.query("ROLLBACK");
          return res.status(400).json({ success: false, error: "این شماره موبایل برای مشتری دیگری ثبت شده است" });
        }
      }

      const updateSql = `
        UPDATE public.customers
        SET
          name = $1,
          mobile = $2,
          national_id = $3,
          address = $4,
          customer_type = $5,
          birth_or_register_date = $6,
          updated_at = NOW()
        WHERE id = $7 AND member_id = $8
        RETURNING *
      `;
      const updateRes = await client.query(updateSql, [
        name || currentCustomer.name,
        mobile || null,
        national_id || null,
        address || null,
        customer_type || "real",
        birth_or_register_date || null,
        id,
        member_id,
      ]);

      if (currentCustomer.tafsili_id && name && currentCustomer.name !== name) {
        await client.query(`UPDATE ${TAFSILI_TABLE} SET title = $1, updated_at = NOW() WHERE id = $2`, [
          String(name).trim(),
          currentCustomer.tafsili_id,
        ]);
      }

      await client.query("COMMIT");
      return res.json({ success: true, data: updateRes.rows[0], message: "ویرایش با موفقیت انجام شد" });
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("❌ Update Customer Error:", e);
      return res.status(500).json({ success: false, error: "خطا در ویرایش مشتری", detail: e.message });
    } finally {
      client.release();
    }
  })
);

// 5) حذف مشتری
router.delete(
  "/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const client = await pool.connect();
    try {
      const member_id = getMemberIdFromReq(req);
      if (!member_id) {
        return res.status(401).json({ success: false, error: "member_id معتبر نیست" });
      }

      const id = req.params.id;

      await client.query("BEGIN");

      const findRes = await client.query(
        "SELECT tafsili_id FROM public.customers WHERE id = $1 AND member_id = $2 LIMIT 1",
        [id, member_id]
      );
      if (!findRes.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ success: false, error: "مشتری یافت نشد" });
      }

      const { tafsili_id } = findRes.rows[0];

      await client.query("DELETE FROM public.customers WHERE id = $1 AND member_id = $2", [id, member_id]);

      if (tafsili_id) {
        await client.query(`DELETE FROM ${TAFSILI_TABLE} WHERE id = $1 AND member_id = $2`, [tafsili_id, member_id]);
      }

      await client.query("COMMIT");
      return res.json({ success: true, message: "مشتری حذف شد" });
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("❌ Delete Customer Error:", e);

      if (e.code === "23503") {
        return res.status(400). json({
          success: false,
          error: "این مشتری دارای سابقه تراکنش مالی است و حذف نمی‌شود.",
        });
      }

      return res.status(500).json({ success: false, error: "خطا در حذف مشتری", detail: e.message });
    } finally {
      client.release();
    }
  })
);

// Error middleware مخصوص این router
router.use((err, req, res, next) => {
  console.error("🔥 Customers Router Error:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({
    success: false,
    error: "خطای داخلی سرور",
    detail: err?.message || "unknown_error",
  });
});

module.exports = router;
