// api/accounting/tafsili.js (Converted to PostgreSQL)
const express = require("express");
const { pool } = require("../../supabaseAdmin"); // مسیر اصلاح شده برای برگشت به روت
const authMiddleware = require("../middleware/auth");

const router = express.Router();

/* GET ALL TAFSILI */
router.get("/", authMiddleware, async (req, res) => {
    try {
        const { is_active, exclude_types, tafsili_type, limit = 500, search } = req.query;
        const member_id = req.user.id;

        let query = `SELECT id, code, title, tafsili_type, is_active, ref_id 
                     FROM public.accounting_tafsili 
                     WHERE member_id = $1`;
        const params = [member_id];

        if (is_active === 'true') {
            query += ` AND is_active = true`;
        }

        if (tafsili_type) {
            params.push(tafsili_type);
            query += ` AND tafsili_type = $${params.length}`;
        }

        if (exclude_types) {
            const types = exclude_types.split(',');
            params.push(types);
            query += ` AND NOT (tafsili_type = ANY($${params.length}))`;
        }

        if (search) {
            params.push(`%${search}%`);
            query += ` AND (code ILIKE $${params.length} OR title ILIKE $${params.length})`;
        }

        query += ` ORDER BY code ASC LIMIT $${params.length + 1}`;
        params.push(limit);

        const { rows } = await pool.query(query, params);
        return res.json({ success: true, data: rows });
    } catch (e) {
        console.error("❌ Get Tafsili Error:", e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* GET TAFSILI BY REF_ID */
router.get("/by-ref/:refId", authMiddleware, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, code, title, tafsili_type FROM public.accounting_tafsili 
             WHERE ref_id = $1 AND member_id = $2 LIMIT 1`,
            [req.params.refId, req.user.id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ success: false, error: "تفصیلی یافت نشد" });
        }

        return res.json({ success: true, data: rows[0] });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* GET ONE TAFSILI */
router.get("/:id", authMiddleware, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT * FROM public.accounting_tafsili WHERE id = $1 AND member_id = $2`,
            [req.params.id, req.user.id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ success: false, error: "تفصیلی یافت نشد" });
        }

        return res.json({ success: true, data: rows[0] });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* CREATE TAFSILI */
router.post("/", authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.id;
        const { code, title, tafsili_type, is_active, ref_id } = req.body;

        const query = `
            INSERT INTO public.accounting_tafsili (code, title, tafsili_type, is_active, ref_id, member_id)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
        `;
        const values = [code, title, tafsili_type, is_active ?? true, ref_id, member_id];

        const { rows } = await pool.query(query, values);
        return res.json({ success: true, data: rows[0], message: "تفصیلی با موفقیت ایجاد شد" });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* UPDATE TAFSILI */
router.put("/:id", authMiddleware, async (req, res) => {
    try {
        const { code, title, tafsili_type, is_active, ref_id } = req.body;
        const member_id = req.user.id;
        const id = req.params.id;

        const query = `
            UPDATE public.accounting_tafsili 
            SET code = $1, title = $2, tafsili_type = $3, is_active = $4, ref_id = $5
            WHERE id = $6 AND member_id = $7
            RETURNING *
        `;
        const values = [code, title, tafsili_type, is_active, ref_id, id, member_id];

        const { rows } = await pool.query(query, values);

        if (rows.length === 0) {
            return res.status(404).json({ success: false, error: "تفصیلی یافت نشد یا دسترسی ندارید" });
        }

        return res.json({ success: true, data: rows[0], message: "تفصیلی با موفقیت ویرایش شد" });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* DELETE TAFSILI */
router.delete("/:id", authMiddleware, async (req, res) => {
    try {
        const { rowCount } = await pool.query(
            `DELETE FROM public.accounting_tafsili WHERE id = $1 AND member_id = $2`,
            [req.params.id, req.user.id]
        );

        if (rowCount === 0) {
            return res.status(404).json({ success: false, error: "تفصیلی یافت نشد" });
        }

        return res.json({ success: true, message: "تفصیلی با موفقیت حذف شد" });
    } catch (e) {
        // مدیریت ارور کلید خارجی (ForeignKey)
        if (e.code === '23503') {
            return res.status(409).json({
                success: false,
                error: "امکان حذف وجود ندارد (در اسناد استفاده شده)"
            });
        }
        return res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;