const express = require("express");
const authMiddleware = require("./middleware/auth");
const { requireSuperAdmin } = require("./middleware/auth");
const { pool } = require("../supabaseAdmin");

const router = express.Router();

const isUUID = (str) => str && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

function normalizeUnit(body = {}) {
    return {
        name: body.name?.trim() || null,
        symbol: body.symbol?.trim() || null,
        code: body.code?.trim() || null,
        description: body.description?.trim() || "",
        is_active: body.is_active !== false,
    };
}

router.get("/", async (req, res) => {
    try {
        const { limit: limitRaw = 100, search } = req.query;
        const limit = Math.min(Math.max(parseInt(limitRaw, 10) || 100, 1), 2000);
        const params = [];
        let where = "WHERE 1=1";
        let idx = 1;

        if (search && String(search).trim()) {
            const s = `%${String(search).trim()}%`;
            params.push(s);
            where += ` AND (name ILIKE $${idx} OR symbol ILIKE $${idx})`;
            idx++;
        }

        const countRes = await pool.query(`SELECT COUNT(*)::int AS total FROM product_units ${where}`, params);
        const total = countRes.rows?.[0]?.total || 0;

        params.push(limit);
        const dataSql = `SELECT * FROM product_units ${where} ORDER BY created_at ASC LIMIT $${idx}`;
        const dataRes = await pool.query(dataSql, params);

        return res.json({ success: true, data: dataRes.rows || [], total, limit });
    } catch (e) {
        console.error("❌ GET Units Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

router.get("/:id", async (req, res) => {
    try {
        const { id } = req.params;
        if (!isUUID(id)) return res.status(400).json({ success: false, error: "شناسه واحد نامعتبر است" });

        const { rows } = await pool.query(`SELECT * FROM product_units WHERE id = $1 LIMIT 1`, [id]);
        if (!rows.length) return res.status(404).json({ success: false, error: "واحد یافت نشد" });

        return res.json({ success: true, data: rows[0] });
    } catch (e) {
        console.error("❌ GET Unit Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

router.post("/", authMiddleware, async (req, res) => {
    try {
        const payload = normalizeUnit(req.body);
        if (!payload.name || !payload.symbol) {
            return res.status(400).json({ success: false, error: "نام و نماد واحد الزامی است" });
        }

        const sql = `INSERT INTO product_units (name, symbol, code, description, is_active, created_at, updated_at)
                      VALUES ($1, $2, $3, $4, $5, NOW(), NOW()) RETURNING *`;
        const { rows } = await pool.query(sql, [payload.name, payload.symbol, payload.code, payload.description, payload.is_active]);

        return res.json({ success: true, data: rows[0], message: "واحد با موفقیت ایجاد شد" });
    } catch (e) {
        console.error("❌ CREATE Unit Error:", e);
        if (e?.code === "23505") return res.status(409).json({ success: false, error: "نام یا نماد واحد تکراری است" });
        return res.status(500).json({ success: false, error: e.message });
    }
});

router.put("/:id", authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        if (!isUUID(id)) return res.status(400).json({ success: false, error: "شناسه واحد نامعتبر است" });

        const payload = normalizeUnit(req.body);
        if (!payload.name || !payload.symbol) {
            return res.status(400).json({ success: false, error: "نام و نماد واحد الزامی است" });
        }

        const sql = `UPDATE product_units SET name=$1, symbol=$2, code=$3, description=$4, is_active=$5, updated_at=NOW()
                      WHERE id=$6 RETURNING *`;
        const { rows } = await pool.query(sql, [payload.name, payload.symbol, payload.code, payload.description, payload.is_active, id]);

        if (!rows.length) return res.status(404).json({ success: false, error: "واحد یافت نشد" });
        return res.json({ success: true, data: rows[0], message: "واحد با موفقیت بروزرسانی شد" });
    } catch (e) {
        console.error("❌ UPDATE Unit Error:", e);
        if (e?.code === "23505") return res.status(409).json({ success: false, error: "نام یا نماد واحد تکراری است" });
        return res.status(500).json({ success: false, error: e.message });
    }
});

router.delete("/:id", authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        if (!isUUID(id)) return res.status(400).json({ success: false, error: "شناسه واحد نامعتبر است" });

        const { rowCount } = await pool.query(`DELETE FROM product_units WHERE id = $1`, [id]);
        if (!rowCount) return res.status(404).json({ success: false, error: "واحد یافت نشد" });

        return res.json({ success: true, message: "واحد با موفقیت حذف شد" });
    } catch (e) {
        console.error("❌ DELETE Unit Error:", e);
        if (e?.code === "23503") return res.status(409).json({ success: false, error: "این واحد در محصولات استفاده شده و قابل حذف نیست" });
        return res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
