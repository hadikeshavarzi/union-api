const express = require("express");
const router = express.Router();
const { pool } = require("../supabaseAdmin");
const authMiddleware = require("./middleware/auth");

const isUUID = (str) =>
  str &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

const toBool = (v) => {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.toLowerCase() === "true";
  return !!v;
};

const toNumberOrNull = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const toNumberOr = (v, fallback = 0) => {
  const n = toNumberOrNull(v);
  return n === null ? fallback : n;
};

const toDateOrNull = (v) => {
  if (v === undefined || v === null || v === "") return null;
  // انتظار: 'YYYY-MM-DD' یا هر چیزی که Date بفهمه
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  // برای Postgres DATE، string ISO کوتاه کافیه
  return d.toISOString().slice(0, 10);
};

const fetchProductWithJoin = async (client, id) => {
  const fetchSql = `
    SELECT p.*,
           c.name as category_name,
           u.name as unit_name
    FROM public.products p
    LEFT JOIN public.product_categories c ON p.category_id = c.id
    LEFT JOIN public.product_units u ON u.id = p.unit_id
    WHERE p.id = $1
  `;
  const result = await client.query(fetchSql, [id]);
  return result.rows[0] || null;
};

// ==========================================================
// GET /products (لیست)
// ==========================================================
router.get("/", authMiddleware, async (req, res) => {
  try {
    const { search, category_id, is_active } = req.query;

    let query = `
      SELECT p.*,
             c.name as category_name,
             u.name as unit_name
      FROM public.products p
      LEFT JOIN public.product_categories c ON p.category_id = c.id
      LEFT JOIN public.product_units u ON u.id = p.unit_id
      WHERE 1=1
    `;
    const params = [];
    let idx = 1;

    if (search) {
      params.push(`%${search}%`);
      query += ` AND (p.name ILIKE $${idx} OR p.sku ILIKE $${idx})`;
      idx++;
    }

    if (category_id && isUUID(category_id)) {
      params.push(category_id);
      query += ` AND p.category_id = $${idx++}`;
    }

    if (is_active !== undefined) {
      params.push(is_active === "true");
      query += ` AND p.is_active = $${idx++}`;
    }

    query += ` ORDER BY p.created_at DESC`;

    const { rows } = await pool.query(query, params);
    res.json({ success: true, data: rows });
  } catch (e) {
    console.error("Products List Error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==========================================================
// GET /products/:id (تکی)
// ==========================================================
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isUUID(id)) return res.status(400).json({ success: false, error: "Invalid ID" });

    const { rows } = await pool.query(`SELECT * FROM public.products WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ success: false, error: "یافت نشد" });

    res.json({ success: true, data: rows[0] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==========================================================
// POST /products (ایجاد مطابق اسکیمای واقعی)
// ==========================================================
router.post("/", authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const member_id = req.user.id;
    const owner_id = req.user.owner_id || member_id;
    const b = req.body;

    // الزامی‌ها
    if (!b.name || String(b.name).trim() === "") {
      return res.status(400).json({ success: false, error: "نام کالا الزامی است" });
    }
    if (!b.category_id || !isUUID(b.category_id)) {
      return res.status(400).json({ success: false, error: "دسته‌بندی الزامی است" });
    }
    if (!b.unit_id || !isUUID(b.unit_id)) {
      return res.status(400).json({ success: false, error: "واحد الزامی است" });
    }

    // SKU (NOT NULL + UNIQUE)
    let finalSku = b.sku;
    if (!finalSku || String(finalSku).trim() === "") {
      finalSku = Math.floor(100000 + Math.random() * 900000).toString();
    }

    await client.query("BEGIN");

    const insertSql = `
      INSERT INTO public.products
      (
        member_id,
        owner_id,
        name,
        sku,
        category_id,
        unit_id,
        min_stock,
        max_stock,
        location,
        price,
        cost_price,
        description,
        specifications,
        barcode,
        batch_number,
        expire_date,
        is_active,
        notes,
        national_id,
        national_title,
        created_at,
        updated_at
      )
      VALUES
      (
        $1,$2,$3,$4,$5,$6,
        $7,$8,$9,$10,$11,
        $12,$13,$14,$15,$16,
        $17,$18,$19,$20,
        NOW(),NOW()
      )
      RETURNING id
    `;

    const values = [
      member_id,
      owner_id,
      b.name,
      finalSku,
      b.category_id,
      b.unit_id,

      toNumberOr(b.min_stock, 0),     // default 0
      toNumberOrNull(b.max_stock),
      b.location || null,

      toNumberOrNull(b.sale_price ?? b.price),
      toNumberOrNull(b.purchase_price ?? b.cost_price),

      b.description || null,
      b.specifications || null,
      b.barcode || null,
      b.batch_number || null,
      toDateOrNull(b.expire_date),

      toBool(b.is_active) ?? true,
      b.notes || null,
      b.national_id || null,
      b.national_title || null,
    ];

    const ins = await client.query(insertSql, values);
    const newId = ins.rows[0].id;

    const fullRow = await fetchProductWithJoin(client, newId);

    await client.query("COMMIT");
    res.json({ success: true, data: fullRow, message: "کالا با موفقیت ثبت شد" });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Create Product Error:", e);
    if (e.code === "23505") {
      return res.status(409).json({ success: false, error: "کد کالا (SKU) تکراری است" });
    }
    res.status(500).json({ success: false, error: e.message });
  } finally {
    client.release();
  }
});

// ==========================================================
// PUT /products/:id (ویرایش مطابق اسکیمای واقعی)
// ==========================================================
router.put("/:id", authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const b = req.body;

    console.log("PUT /products/:id", id);
    console.log("content-type:", req.headers["content-type"]);
    console.log("body:", b);

    if (!isUUID(id)) {
      return res.status(400).json({ success: false, error: "شناسه نامعتبر" });
    }

    // 1) دریافت رکورد قبلی
    const prev = await client.query(`SELECT * FROM public.products WHERE id = $1`, [id]);
    if (prev.rowCount === 0) {
      return res.status(404).json({ success: false, error: "کالا یافت نشد" });
    }
    const old = prev.rows[0];

    // 2) فیلدهای اجباری (NOT NULL) با fallback
    const finalName = (b.name !== undefined ? b.name : old.name);
    const finalCategory = (b.category_id && isUUID(b.category_id)) ? b.category_id : old.category_id;
    const finalUnit = (b.unit_id && isUUID(b.unit_id)) ? b.unit_id : old.unit_id;

    let finalSku = (b.sku !== undefined ? b.sku : old.sku);
    if (!finalSku || String(finalSku).trim() === "") finalSku = old.sku;

    const toBool = (v) => {
      if (v === undefined || v === null) return undefined;
      if (typeof v === "boolean") return v;
      if (typeof v === "string") return v.toLowerCase() === "true";
      return !!v;
    };
    const toNumberOrNull = (v) => {
      if (v === undefined || v === null || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const toNumberOr = (v, fallback = 0) => {
      const n = toNumberOrNull(v);
      return n === null ? fallback : n;
    };
    const toDateOrNull = (v) => {
      if (v === undefined || v === null || v === "") return null;
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) return null;
      return d.toISOString().slice(0, 10);
    };

    const finalIsActive =
      toBool(b.is_active) !== undefined ? toBool(b.is_active) : old.is_active;

    await client.query("BEGIN");

    // 3) UPDATE (طبق اسکیمای واقعی: quantity نداریم!)
    const updateSql = `
      UPDATE public.products SET
        name = $1,
        sku = $2,
        category_id = $3,
        unit_id = $4,
        min_stock = $5,
        max_stock = $6,
        location = $7,
        price = $8,
        cost_price = $9,
        description = $10,
        specifications = $11,
        barcode = $12,
        batch_number = $13,
        expire_date = $14,
        is_active = $15,
        notes = $16,
        national_id = $17,
        national_title = $18,
        updated_at = NOW()
      WHERE id = $19
      RETURNING id
    `;

    const values = [
      finalName,
      finalSku,
      finalCategory,
      finalUnit,

      b.min_stock !== undefined ? toNumberOr(b.min_stock, 0) : (old.min_stock ?? 0),
      b.max_stock !== undefined ? toNumberOrNull(b.max_stock) : old.max_stock,
      b.location !== undefined ? (b.location || null) : old.location,

      (b.sale_price !== undefined || b.price !== undefined)
        ? toNumberOrNull(b.sale_price ?? b.price)
        : old.price,

      (b.purchase_price !== undefined || b.cost_price !== undefined)
        ? toNumberOrNull(b.purchase_price ?? b.cost_price)
        : old.cost_price,

      b.description !== undefined ? (b.description || null) : old.description,
      b.specifications !== undefined ? (b.specifications || null) : old.specifications,
      b.barcode !== undefined ? (b.barcode || null) : old.barcode,
      b.batch_number !== undefined ? (b.batch_number || null) : old.batch_number,
      b.expire_date !== undefined ? toDateOrNull(b.expire_date) : old.expire_date,

      finalIsActive,
      b.notes !== undefined ? (b.notes || null) : old.notes,
      b.national_id !== undefined ? (b.national_id || null) : old.national_id,
      b.national_title !== undefined ? (b.national_title || null) : old.national_title,

      id,
    ];

    const upd = await client.query(updateSql, values);
    console.log("update rowCount:", upd.rowCount);

    if (upd.rowCount === 0) {
      throw new Error("آپدیت انجام نشد (rowCount=0)");
    }

    // 4) fetch با join
    const fetchSql = `
      SELECT p.*,
             c.name as category_name,
             u.name as unit_name
      FROM public.products p
      LEFT JOIN public.product_categories c ON p.category_id = c.id
      LEFT JOIN public.product_units u ON u.id = p.unit_id
      WHERE p.id = $1
    `;
    const result = await client.query(fetchSql, [id]);

    await client.query("COMMIT");
    return res.json({ success: true, data: result.rows[0], message: "بروزرسانی شد" });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Update Product Error:", e);
    // فقط یکبار جواب بده
    return res.status(500).json({ success: false, error: e.message });
  } finally {
    client.release();
  }
});


// ==========================================================
// DELETE /products/:id
// ==========================================================
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isUUID(id)) return res.status(400).json({ success: false, error: "Invalid ID" });

    const result = await pool.query("DELETE FROM public.products WHERE id = $1", [id]);
    if (result.rowCount === 0) return res.status(404).json({ success: false, error: "یافت نشد" });

    res.json({ success: true, message: "حذف شد" });
  } catch (e) {
    if (e.code === "23503") {
      return res.status(400).json({ success: false, error: "این کالا در سیستم استفاده شده و قابل حذف نیست" });
    }
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
