// api/accounting/gl.js
const express = require("express");
const { pool } = require("../../supabaseAdmin"); // فقط pool لازم است
const authMiddleware = require("../middleware/auth");

const router = express.Router();

/* GET ALL GL (With Group Relation) */
router.get("/", authMiddleware, async (req, res) => {
    try {
        const { group_id } = req.query;

        // ساخت کوئری با Join و تبدیل خروجی به JSON تودرتو
        // gl.* اطلاعات جدول کل را می‌گیرد
        // json_build_object اطلاعات گروه را به عنوان یک آبجکت داخل فیلد "group" می‌گذارد
        let queryText = `
            SELECT 
                gl.*,
                json_build_object(
                    'id', gr.id, 
                    'code', gr.code, 
                    'title', gr.title
                ) as "group"
            FROM public.accounting_gl gl
            LEFT JOIN public.accounting_groups gr ON gl.group_id = gr.id
            WHERE 1=1
        `;

        const queryParams = [];
        let paramCounter = 1;

        // فیلتر بر اساس Group ID
        if (group_id) {
            queryText += ` AND gl.group_id = $${paramCounter}`;
            queryParams.push(group_id);
            paramCounter++;
        }

        queryText += ` ORDER BY gl.code ASC`;

        const result = await pool.query(queryText, queryParams);

        return res.json({ success: true, data: result.rows });
    } catch (e) {
        console.error("Error inside GET GL:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* GET ONE GL */
router.get("/:id", authMiddleware, async (req, res) => {
    try {
        const id = req.params.id;

        const query = `
            SELECT 
                gl.*,
                json_build_object(
                    'id', gr.id, 
                    'code', gr.code, 
                    'title', gr.title
                ) as "group"
            FROM public.accounting_gl gl
            LEFT JOIN public.accounting_groups gr ON gl.group_id = gr.id
            WHERE gl.id = $1
            LIMIT 1
        `;

        const result = await pool.query(query, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "حساب کل یافت نشد" });
        }

        return res.json({ success: true, data: result.rows[0] });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* CREATE GL (Admin only) */
router.post("/", authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({
                success: false,
                error: "فقط ادمین می‌تواند حساب کل ایجاد کند"
            });
        }

        const body = req.body;
        const payload = { ...body };
        delete payload.id;
        delete payload.created_at;

        // ساخت کوئری داینامیک INSERT
        const keys = Object.keys(payload);
        const values = Object.values(payload);
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
        const columns = keys.join(", ");

        const query = `
            INSERT INTO public.accounting_gl (${columns}) 
            VALUES (${placeholders}) 
            RETURNING *
        `;

        const result = await pool.query(query, values);

        return res.json({
            success: true,
            data: result.rows[0],
            message: "حساب کل با موفقیت ایجاد شد"
        });

    } catch (e) {
        if (e.code === '23505') {
            return res.status(409).json({ success: false, error: "کد حساب کل تکراری است" });
        }
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* UPDATE GL (Admin only) */
router.put("/:id", authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({
                success: false,
                error: "فقط ادمین می‌تواند حساب کل ویرایش کند"
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
            UPDATE public.accounting_gl 
            SET ${setClause} 
            WHERE id = $${values.length} 
            RETURNING *
        `;

        const result = await pool.query(query, values);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "حساب کل یافت نشد" });
        }

        return res.json({
            success: true,
            data: result.rows[0],
            message: "حساب کل با موفقیت ویرایش شد"
        });

    } catch (e) {
        if (e.code === '23505') {
            return res.status(409).json({ success: false, error: "کد حساب کل تکراری است" });
        }
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* DELETE GL (Admin only) */
router.delete("/:id", authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({
                success: false,
                error: "فقط ادمین می‌تواند حساب کل حذف کند"
            });
        }

        const id = req.params.id;
        const query = `DELETE FROM public.accounting_gl WHERE id = $1`;

        await pool.query(query, [id]);

        return res.json({ success: true, message: "حساب کل با موفقیت حذف شد" });

    } catch (e) {
        if (e.code === '23503') {
            return res.status(409).json({
                success: false,
                error: "امکان حذف وجود ندارد (دارای معین وابسته)"
            });
        }
        return res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;