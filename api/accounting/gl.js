// api/accounting/gl.js
const express = require("express");
const { supabaseAdmin } = require("../../supabaseAdmin");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

/* GET ALL GL */
router.get("/", authMiddleware, async (req, res) => {
    try {
        const { group_id } = req.query;

        let query = supabaseAdmin
            .from("accounting_gl")
            .select(`
                *,
                group:accounting_groups(id, code, title)
            `)
            .order("code", { ascending: true });

        if (group_id) {
            query = query.eq("group_id", group_id);
        }

        const { data, error } = await query;

        if (error) throw error;

        return res.json({ success: true, data });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* GET ONE GL */
router.get("/:id", authMiddleware, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from("accounting_gl")
            .select(`
                *,
                group:accounting_groups(id, code, title)
            `)
            .eq("id", req.params.id)
            .single();

        if (error || !data) {
            return res.status(404).json({ success: false, error: "کل یافت نشد" });
        }

        return res.json({ success: true, data });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* CREATE GL */
router.post("/", authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({
                success: false,
                error: "فقط ادمین می‌تواند کل ایجاد کند"
            });
        }

        const { data, error } = await supabaseAdmin
            .from("accounting_gl")
            .insert([req.body])
            .select()
            .single();

        if (error) throw error;

        return res.json({ success: true, data, message: "کل با موفقیت ایجاد شد" });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* UPDATE GL */
router.put("/:id", authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({
                success: false,
                error: "فقط ادمین می‌تواند کل ویرایش کند"
            });
        }

        const payload = { ...req.body };
        delete payload.id;
        delete payload.created_at;

        const { data, error } = await supabaseAdmin
            .from("accounting_gl")
            .update(payload)
            .eq("id", req.params.id)
            .select()
            .single();

        if (error) throw error;

        return res.json({ success: true, data, message: "کل با موفقیت ویرایش شد" });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* DELETE GL */
router.delete("/:id", authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({
                success: false,
                error: "فقط ادمین می‌تواند کل حذف کند"
            });
        }

        const { error } = await supabaseAdmin
            .from("accounting_gl")
            .delete()
            .eq("id", req.params.id);

        if (error) {
            if (error.code === '23503') {
                return res.status(409).json({
                    success: false,
                    error: "امکان حذف وجود ندارد (دارای معین وابسته)"
                });
            }
            throw error;
        }

        return res.json({ success: true, message: "کل با موفقیت حذف شد" });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;