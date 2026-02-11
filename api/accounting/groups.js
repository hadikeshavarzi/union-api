// api/accounting/groups.js
const express = require("express");
const { pool } = require("../../supabaseAdmin"); // فقط pool لازم است
const authMiddleware = require("../middleware/auth");

const router = express.Router();

/* GET ALL GROUPS */
router.get("/", authMiddleware, async (req, res) => {
    try {
        // گروه‌های حسابداری معمولاً عمومی هستند (بدون فیلتر member_id)
        // مرتب‌سازی بر اساس کد
        const query = `
            SELECT * FROM public.accounting_groups 
            ORDER BY code ASC
        `;
        const result = await pool.query(query);

        return res.json({ success: true, data: result.rows });
    } catch (e) {
        console.error("Error fetching groups:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* GET ONE GROUP */
router.get("/:id", authMiddleware, async (req, res) => {
    try {
        const id = req.params.id;
        const query = `SELECT * FROM public.accounting_groups WHERE id = $1`;

        const result = await pool.query(query, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "گروه یافت نشد" });
        }

        return res.json({ success: true, data: result.rows[0] });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* CREATE GROUP (Admin only) */
router.post("/", authMiddleware, async (req, res) => {
    try {
        // چک دسترسی admin
        if (req.user.role !== 'admin') {
            return res.status(403).json({
                success: false,
                error: "فقط ادمین می‌تواند گروه ایجاد کند"
            });
        }

        const body = req.body;
        // ساخت کوئری داینامیک برای INSERT
        // فرض بر این است که بادی شامل فیلدهای معتبر (code, title, nature, ...) است
        const keys = Object.keys(body);
        const values = Object.values(body);

        // مثال: ($1, $2, $3)
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
        const columns = keys.join(", ");

        const query = `
            INSERT INTO public.accounting_groups (${columns}) 
            VALUES (${placeholders}) 
            RETURNING *
        `;

        const result = await pool.query(query, values);

        return res.json({
            success: true,
            data: result.rows[0],
            message: "گروه با موفقیت ایجاد شد"
        });

    } catch (e) {
        // مدیریت تکراری بودن کد گروه (Unique Constraint)
        if (e.code === '23505') {
            return res.status(409).json({ success: false, error: "این کد گروه قبلا ثبت شده است" });
        }
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* UPDATE GROUP (Admin only) */
router.put("/:id", authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({
                success: false,
                error: "فقط ادمین می‌تواند گروه ویرایش کند"
            });
        }

        const id = req.params.id;
        const payload = { ...req.body };

        // حذف فیلدهای غیرقابل ویرایش
        delete payload.id;
        delete payload.created_at;

        const keys = Object.keys(payload);
        if (keys.length === 0) {
            return res.status(400).json({ success: false, error: "هیچ داده‌ای برای ویرایش ارسال نشده است" });
        }

        // ساخت کوئری داینامیک UPDATE
        // مثال: code = $1, title = $2
        const setClause = keys.map((key, index) => `${key} = $${index + 1}`).join(", ");
        const values = Object.values(payload);

        // اضافه کردن ID به انتهای آرایه مقادیر برای WHERE
        values.push(id);

        const query = `
            UPDATE public.accounting_groups 
            SET ${setClause} 
            WHERE id = $${values.length} 
            RETURNING *
        `;

        const result = await pool.query(query, values);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "گروه یافت نشد" });
        }

        return res.json({
            success: true,
            data: result.rows[0],
            message: "گروه با موفقیت ویرایش شد"
        });

    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* DELETE GROUP (Admin only) */
router.delete("/:id", authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({
                success: false,
                error: "فقط ادمین می‌تواند گروه حذف کند"
            });
        }

        const id = req.params.id;
        const query = `DELETE FROM public.accounting_groups WHERE id = $1`;

        await pool.query(query, [id]);

        return res.json({ success: true, message: "گروه با موفقیت حذف شد" });

    } catch (e) {
        // مدیریت ارور کلید خارجی (اگر گروه در جداول دیگر استفاده شده باشد)
        if (e.code === '23503') {
            return res.status(409).json({
                success: false,
                error: "امکان حذف وجود ندارد (دارای کل وابسته)"
            });
        }
        return res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;