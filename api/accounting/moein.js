// api/accounting/moein.js
const express = require("express");
const { pool } = require("../../supabaseAdmin"); // فقط pool لازم است
const authMiddleware = require("../middleware/auth");

const router = express.Router();

/* GET ALL MOEIN */
router.get("/", authMiddleware, async (req, res) => {
    try {
        const { gl_id, is_active } = req.query;

        // ساخت کوئری با ساختار JSON تودرتو (Nested)
        // این کوئری دقیقاً خروجی‌ای شبیه به Supabase تولید می‌کند
        let queryText = `
            SELECT 
                m.*,
                json_build_object(
                    'id', gl.id, 
                    'code', gl.code, 
                    'title', gl.title,
                    'group', json_build_object(
                        'id', gr.id,
                        'code', gr.code,
                        'title', gr.title
                    )
                ) as gl
            FROM public.accounting_moein m
            LEFT JOIN public.accounting_gl gl ON m.gl_id = gl.id
            LEFT JOIN public.accounting_groups gr ON gl.group_id = gr.id
            WHERE 1=1
        `;

        const queryParams = [];
        let paramCounter = 1;

        // فیلتر بر اساس GL ID
        if (gl_id) {
            queryText += ` AND m.gl_id = $${paramCounter}`;
            queryParams.push(gl_id);
            paramCounter++;
        }

        // فیلتر فعال بودن
        if (is_active === 'true') {
            queryText += ` AND m.is_active = $${paramCounter}`;
            queryParams.push(true);
            paramCounter++;
        }

        queryText += ` ORDER BY m.code ASC`;

        const result = await pool.query(queryText, queryParams);

        return res.json({ success: true, data: result.rows });
    } catch (e) {
        console.error("Error in GET moein:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* GET MOEIN BY CODE */
router.get("/by-code/:code", authMiddleware, async (req, res) => {
    try {
        const code = req.params.code;
        // در اینجا فقط فیلدهای خاصی خواسته شده بود
        const query = `
            SELECT id, code, title 
            FROM public.accounting_moein 
            WHERE code = $1 
            LIMIT 1
        `;

        const result = await pool.query(query, [code]);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "معین یافت نشد" });
        }

        return res.json({ success: true, data: result.rows[0] });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* GET ONE MOEIN (With Relations) */
router.get("/:id", authMiddleware, async (req, res) => {
    try {
        const id = req.params.id;

        // کوئری تکی با Join
        const query = `
            SELECT 
                m.*,
                json_build_object(
                    'id', gl.id, 
                    'code', gl.code, 
                    'title', gl.title
                ) as gl
            FROM public.accounting_moein m
            LEFT JOIN public.accounting_gl gl ON m.gl_id = gl.id
            WHERE m.id = $1
            LIMIT 1
        `;

        const result = await pool.query(query, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "معین یافت نشد" });
        }

        return res.json({ success: true, data: result.rows[0] });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* CREATE MOEIN */
router.post("/", authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({
                success: false,
                error: "فقط ادمین می‌تواند معین ایجاد کند"
            });
        }

        const body = req.body;
        // آماده‌سازی داده‌ها
        const payload = { ...body };
        delete payload.id;
        delete payload.created_at;

        // ساخت کوئری داینامیک INSERT
        const keys = Object.keys(payload);
        const values = Object.values(payload);
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
        const columns = keys.join(", ");

        const query = `
            INSERT INTO public.accounting_moein (${columns}) 
            VALUES (${placeholders}) 
            RETURNING *
        `;

        const result = await pool.query(query, values);

        return res.json({
            success: true,
            data: result.rows[0],
            message: "معین با موفقیت ایجاد شد"
        });

    } catch (e) {
        if (e.code === '23505') {
            return res.status(409).json({ success: false, error: "کد معین تکراری است" });
        }
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* UPDATE MOEIN */
router.put("/:id", authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({
                success: false,
                error: "فقط ادمین می‌تواند معین ویرایش کند"
            });
        }

        const id = req.params.id;
        const payload = { ...req.body };
        delete payload.id;
        delete payload.created_at;

        const keys = Object.keys(payload);
        if (keys.length === 0) {
            return res.status(400).json({ success: false, error: "داده‌ای ارسال نشده است" });
        }

        // ساخت کوئری داینامیک UPDATE
        const setClause = keys.map((key, index) => `${key} = $${index + 1}`).join(", ");
        const values = Object.values(payload);

        values.push(id); // پارامتر آخر برای WHERE

        const query = `
            UPDATE public.accounting_moein 
            SET ${setClause} 
            WHERE id = $${values.length} 
            RETURNING *
        `;

        const result = await pool.query(query, values);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "معین یافت نشد" });
        }

        return res.json({
            success: true,
            data: result.rows[0],
            message: "معین با موفقیت ویرایش شد"
        });

    } catch (e) {
        if (e.code === '23505') {
            return res.status(409).json({ success: false, error: "کد معین تکراری است" });
        }
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* DELETE MOEIN */
router.delete("/:id", authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({
                success: false,
                error: "فقط ادمین می‌تواند معین حذف کند"
            });
        }

        const id = req.params.id;
        const query = `DELETE FROM public.accounting_moein WHERE id = $1`;

        await pool.query(query, [id]);

        return res.json({ success: true, message: "معین با موفقیت حذف شد" });

    } catch (e) {
        if (e.code === '23503') {
            return res.status(409).json({
                success: false,
                error: "امکان حذف وجود ندارد (در اسناد استفاده شده است)"
            });
        }
        return res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;