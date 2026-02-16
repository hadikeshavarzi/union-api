// api/productUnits.js - SQL Based (Postgres) - COMPLETE
const express = require("express");
const authMiddleware = require("./middleware/auth");
const { requireSuperAdmin } = require("./middleware/auth");
const { pool } = require("../supabaseAdmin");

const router = express.Router();

/* =====================================================================
   UTIL: Normalize
===================================================================== */
function normalizeUnit(body = {}) {
    const out = {
        name: body.name?.trim() || null,
        symbol: body.symbol?.trim() || null,
        // اگر فیلدهای دیگری دارید همینجا whitelist کنید
    };
    return out;
}

/* ============================================================================
   GET ALL – دریافت همه واحدها (Public)
   Query:
     - limit (default 100, max 2000)
     - search (ILIKE on name/symbol)
============================================================================ */
router.get("/", async (req, res) => {
    try {
        const { limit: limitRaw = 100, search } = req.query;
        const limit = Math.min(Math.max(parseInt(limitRaw, 10) || 100, 1), 2000);

        const params = [];
        let where = "WHERE 1=1";

        if (search && String(search).trim()) {
            const s = `%${String(search).trim()}%`;
            params.push(s);
            params.push(s);
            where += ` AND (name ILIKE $${params.length - 1} OR symbol ILIKE $${params.length})`;
        }

        // count
        const countSql = `SELECT COUNT(*)::bigint AS total FROM product_units ${where}`;
        const countRes = await pool.query(countSql, params);
        const total = Number(countRes.rows?.[0]?.total || 0);

        // data
        params.push(limit);
        const dataSql = `
      SELECT *
      FROM product_units
      ${where}
      ORDER BY id ASC
      LIMIT $${params.length}
    `;
        const dataRes = await pool.query(dataSql, params);

        return res.json({
            success: true,
            data: dataRes.rows || [],
            total,
            limit,
        });
    } catch (e) {
        console.error("❌ GET Units Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================================
   GET ONE – دریافت یک واحد (Public)
============================================================================ */
router.get("/:id", async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) {
            return res.status(400).json({ success: false, error: "Invalid unit id" });
        }

        const sql = `SELECT * FROM product_units WHERE id = $1 LIMIT 1`;
        const r = await pool.query(sql, [id]);

        const row = r.rows?.[0];
        if (!row) {
            return res.status(404).json({ success: false, error: "واحد یافت نشد" });
        }

        return res.json({ success: true, data: row });
    } catch (e) {
        console.error("❌ GET Unit Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================================
   CREATE – ایجاد واحد جدید (Protected)
============================================================================ */
router.post("/", authMiddleware, requireSuperAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        const payload = normalizeUnit(req.body);

        if (!payload.name || !payload.symbol) {
            return res.status(400).json({
                success: false,
                error: "نام و نماد واحد الزامی است",
            });
        }

        await client.query("BEGIN");

        const sql = `
      INSERT INTO product_units (
        name, symbol, created_at, updated_at
      )
      VALUES (
        $1, $2, NOW(), NOW()
      )
      RETURNING *
    `;

        const r = await client.query(sql, [payload.name, payload.symbol]);

        await client.query("COMMIT");

        return res.json({
            success: true,
            data: r.rows[0],
            message: "واحد با موفقیت ایجاد شد",
        });
    } catch (e) {
        await client.query("ROLLBACK");
        console.error("❌ CREATE Unit Error:", e);

        // اگر name یا symbol یونیک باشد
        if (e?.code === "23505") {
            return res.status(409).json({
                success: false,
                error: "نام یا نماد واحد تکراری است",
            });
        }

        return res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

/* ============================================================================
   UPDATE – ویرایش واحد (Protected)
============================================================================ */
router.put("/:id", authMiddleware, requireSuperAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) {
            return res.status(400).json({ success: false, error: "Invalid unit id" });
        }

        const payload = normalizeUnit(req.body);

        if (!payload.name || !payload.symbol) {
            return res.status(400).json({
                success: false,
                error: "نام و نماد واحد الزامی است",
            });
        }

        await client.query("BEGIN");

        const sql = `
      UPDATE product_units
      SET
        name = $1,
        symbol = $2,
        updated_at = NOW()
      WHERE id = $3
      RETURNING *
    `;

        const r = await client.query(sql, [payload.name, payload.symbol, id]);

        if (!r.rows?.length) {
            await client.query("ROLLBACK");
            return res.status(404).json({ success: false, error: "واحد یافت نشد" });
        }

        await client.query("COMMIT");

        return res.json({
            success: true,
            data: r.rows[0],
            message: "واحد با موفقیت بروزرسانی شد",
        });
    } catch (e) {
        await client.query("ROLLBACK");
        console.error("❌ UPDATE Unit Error:", e);

        if (e?.code === "23505") {
            return res.status(409).json({
                success: false,
                error: "نام یا نماد واحد تکراری است",
            });
        }

        return res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

/* ============================================================================
   PATCH – تغییر جزئی (Protected)  (اختیاری ولی خیلی کاربردی)
============================================================================ */
router.patch("/:id", authMiddleware, requireSuperAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) {
            return res.status(400).json({ success: false, error: "Invalid unit id" });
        }

        const body = req.body || {};
        delete body.id;
        delete body.created_at;
        delete body.updated_at;

        const allowed = new Set(["name", "symbol"]);
        const keys = Object.keys(body).filter(k => allowed.has(k));

        if (!keys.length) {
            return res.json({ success: true, message: "فیلد مجاز برای تغییر ارسال نشده است" });
        }

        const setParts = [];
        const params = [];
        let idx = 1;

        for (const k of keys) {
            let v = body[k];
            if (typeof v === "string") v = v.trim();
            params.push(v);
            setParts.push(`${k} = $${idx++}`);
        }

        setParts.push(`updated_at = NOW()`);
        params.push(id);

        await client.query("BEGIN");

        const sql = `
      UPDATE product_units
      SET ${setParts.join(", ")}
      WHERE id = $${idx}
      RETURNING *
    `;
        const r = await client.query(sql, params);

        if (!r.rows?.length) {
            await client.query("ROLLBACK");
            return res.status(404).json({ success: false, error: "واحد یافت نشد" });
        }

        await client.query("COMMIT");
        return res.json({ success: true, data: r.rows[0] });
    } catch (e) {
        await client.query("ROLLBACK");
        console.error("❌ PATCH Unit Error:", e);

        if (e?.code === "23505") {
            return res.status(409).json({ success: false, error: "نام یا نماد واحد تکراری است" });
        }

        return res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

/* ============================================================================
   DELETE – حذف واحد (Protected)
============================================================================ */
router.delete("/:id", authMiddleware, requireSuperAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) {
            return res.status(400).json({ success: false, error: "Invalid unit id" });
        }

        try {
            const r = await pool.query(
                `DELETE FROM product_units WHERE id = $1 RETURNING id`,
                [id]
            );

            if (!r.rows?.length) {
                return res.status(404).json({ success: false, error: "واحد یافت نشد" });
            }
        } catch (err) {
            // Foreign key violation
            if (err?.code === "23503") {
                return res.status(409).json({
                    success: false,
                    error: "امکان حذف این واحد وجود ندارد",
                    message: "این واحد در محصولات استفاده شده است",
                });
            }
            throw err;
        }

        return res.json({ success: true, message: "واحد با موفقیت حذف شد" });
    } catch (e) {
        console.error("❌ DELETE Unit Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
