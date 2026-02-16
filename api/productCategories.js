// api/productCategories.js - GLOBAL MODE (No owner_id)
const express = require("express");
const authMiddleware = require("./middleware/auth");
const { requireSuperAdmin } = require("./middleware/auth");
const { pool } = require("../supabaseAdmin");
const router = express.Router();

const isUUID = (str) => {
    if (!str) return false;
    const regex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return regex.test(str);
};

function normalizeCategory(body = {}) {
    return {
        name: body.name?.trim() || null,
        slug: body.slug?.trim() || null,
        parent_id: (body.parent_id && isUUID(body.parent_id)) ? body.parent_id : null,
        description: body.description ?? "",
        image_id: (body.image_id && isUUID(body.image_id)) ? body.image_id : null,
        is_active: body.is_active !== false,
        sort_order: Number(body.sort_order) || 0,
        storage_cost: Number(body.storage_cost) || 0,
        loading_cost: Number(body.loading_cost) || 0,
    };
}

// GET ALL (بدون فیلتر owner_id)
router.get("/", authMiddleware, async (req, res) => {
    try {
        const { limit: limitRaw = 500, search, parent_id, is_active } = req.query;
        const limit = Math.min(Math.max(parseInt(limitRaw, 10) || 500, 1), 2000);

        const params = [];
        let where = "WHERE 1=1"; // شرط همیشه درست (چون owner_id نداریم)
        let idx = 1;

        if (search && String(search).trim()) {
            params.push(`%${String(search).trim()}%`);
            where += ` AND name ILIKE $${idx++}`;
        }
        if (parent_id && isUUID(parent_id)) {
            params.push(parent_id);
            where += ` AND parent_id = $${idx++}`;
        }
        if (is_active !== undefined) {
            params.push(is_active === 'true');
            where += ` AND is_active = $${idx++}`;
        }

        params.push(limit);

        const dataSql = `
            SELECT * FROM public.product_categories
            ${where}
            ORDER BY sort_order ASC, created_at DESC
            LIMIT $${idx}
        `;

        const { rows } = await pool.query(dataSql, params);
        res.json({ success: true, data: rows || [], count: rows.length });
    } catch (e) {
        console.error("GET Categories Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET ONE
router.get("/:id", authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        if (!isUUID(id)) return res.status(400).json({ success: false, error: "Invalid ID" });

        // حذف شرط owner_id
        const sql = `SELECT * FROM public.product_categories WHERE id = $1 LIMIT 1`;
        const { rows } = await pool.query(sql, [id]);
        if (!rows.length) return res.status(404).json({ success: false, error: "Not Found" });
        res.json({ success: true, data: rows[0] });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// CREATE (فقط سوپرادمین)
router.post("/", authMiddleware, requireSuperAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        // حذف owner_id از ورودی
        const payload = normalizeCategory(req.body);
        if (!payload.name) return res.status(400).json({ success: false, error: "Name required" });

        await client.query("BEGIN");

        // حذف ستون owner_id از اینسرت
        const sql = `
            INSERT INTO public.product_categories (
                name, slug, parent_id, description, image_id,
                is_active, sort_order, storage_cost, loading_cost,
                created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
            RETURNING *
        `;
        const r = await client.query(sql, [
            payload.name, payload.slug, payload.parent_id, payload.description,
            payload.image_id, payload.is_active, payload.sort_order, payload.storage_cost, payload.loading_cost
        ]);
        await client.query("COMMIT");
        res.json({ success: true, data: r.rows[0], message: "ایجاد شد" });
    } catch (e) {
        await client.query("ROLLBACK");
        console.error("CREATE Error:", e);
        if (e.code === "23505") return res.status(409).json({ success: false, error: "تکراری" });
        res.status(500).json({ success: false, error: e.message });
    } finally { client.release(); }
});

// UPDATE (فقط سوپرادمین)
router.put("/:id", authMiddleware, requireSuperAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        if (!isUUID(id)) return res.status(400).json({ success: false, error: "Invalid ID" });

        const payload = normalizeCategory(req.body);
        if (!payload.name) return res.status(400).json({ success: false, error: "Name required" });

        await client.query("BEGIN");

        // حذف owner_id از شرط
        const sql = `
            UPDATE public.product_categories
            SET name=$1, slug=$2, parent_id=$3, description=$4, image_id=$5,
                is_active=$6, sort_order=$7, storage_cost=$8, loading_cost=$9, updated_at=NOW()
            WHERE id=$10
            RETURNING *
        `;
        const r = await client.query(sql, [
            payload.name, payload.slug, payload.parent_id, payload.description, payload.image_id,
            payload.is_active, payload.sort_order, payload.storage_cost, payload.loading_cost,
            id
        ]);

        if (!r.rows.length) {
            await client.query("ROLLBACK");
            return res.status(404).json({ success: false, error: "Not Found" });
        }
        await client.query("COMMIT");
        res.json({ success: true, data: r.rows[0], message: "بروزرسانی شد" });
    } catch (e) {
        await client.query("ROLLBACK");
        res.status(500).json({ success: false, error: e.message });
    } finally { client.release(); }
});

// DELETE (فقط سوپرادمین)
router.delete("/:id", authMiddleware, requireSuperAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        if (!isUUID(id)) return res.status(400).json({ success: false, error: "Invalid ID" });

        // حذف owner_id از شرط
        const r = await pool.query(`DELETE FROM public.product_categories WHERE id=$1`, [id]);
        if (r.rowCount === 0) return res.status(404).json({ success: false, error: "Not Found" });

        res.json({ success: true, message: "حذف شد" });
    } catch (e) {
        if (e.code === "23503") return res.status(409).json({ success: false, error: "وابستگی دارد" });
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;