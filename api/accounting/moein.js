// api/accounting/moein.js
const express = require("express");
const { supabaseAdmin } = require("../../supabaseAdmin");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

/* GET ALL MOEIN */
router.get("/", authMiddleware, async (req, res) => {
    try {
        const { gl_id, is_active } = req.query;

        let query = supabaseAdmin
            .from("accounting_moein")
            .select(`
                *,
                gl:accounting_gl(id, code, title),
                group:accounting_gl(group:accounting_groups(id, code, title))
            `)
            .order("code", { ascending: true });

        if (gl_id) {
            query = query.eq("gl_id", gl_id);
        }

        if (is_active === 'true') {
            query = query.eq("is_active", true);
        }

        const { data, error } = await query;

        if (error) throw error;

        return res.json({ success: true, data });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* GET MOEIN BY CODE */
router.get("/by-code/:code", authMiddleware, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from("accounting_moein")
            .select("id, code, title")
            .eq("code", req.params.code)
            .single();

        if (error || !data) {
            return res.status(404).json({ success: false, error: "معین یافت نشد" });
        }

        return res.json({ success: true, data });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* GET ONE MOEIN */
router.get("/:id", authMiddleware, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from("accounting_moein")
            .select(`
                *,
                gl:accounting_gl(id, code, title)
            `)
            .eq("id", req.params.id)
            .single();

        if (error || !data) {
            return res.status(404).json({ success: false, error: "معین یافت نشد" });
        }

        return res.json({ success: true, data });
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

        const { data, error } = await supabaseAdmin
            .from("accounting_moein")
            .insert([req.body])
            .select()
            .single();

        if (error) throw error;

        return res.json({ success: true, data, message: "معین با موفقیت ایجاد شد" });
    } catch (e) {
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

        const payload = { ...req.body };
        delete payload.id;
        delete payload.created_at;

        const { data, error } = await supabaseAdmin
            .from("accounting_moein")
            .update(payload)
            .eq("id", req.params.id)
            .select()
            .single();

        if (error) throw error;

        return res.json({ success: true, data, message: "معین با موفقیت ویرایش شد" });
    } catch (e) {
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

        const { error } = await supabaseAdmin
            .from("accounting_moein")
            .delete()
            .eq("id", req.params.id);

        if (error) {
            if (error.code === '23503') {
                return res.status(409).json({
                    success: false,
                    error: "امکان حذف وجود ندارد (در اسناد استفاده شده)"
                });
            }
            throw error;
        }

        return res.json({ success: true, message: "معین با موفقیت حذف شد" });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;