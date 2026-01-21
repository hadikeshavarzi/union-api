// api/accounting/groups.js
const express = require("express");
const { supabaseAdmin } = require("../../supabaseAdmin");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

/* GET ALL GROUPS */
router.get("/", authMiddleware, async (req, res) => {
    try {
        // Groups معمولاً shared هستند (بدون member_id)
        const { data, error } = await supabaseAdmin
            .from("accounting_groups")
            .select("*")
            .order("code", { ascending: true });

        if (error) throw error;

        return res.json({ success: true, data });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* GET ONE GROUP */
router.get("/:id", authMiddleware, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from("accounting_groups")
            .select("*")
            .eq("id", req.params.id)
            .single();

        if (error || !data) {
            return res.status(404).json({ success: false, error: "گروه یافت نشد" });
        }

        return res.json({ success: true, data });
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

        const { data, error } = await supabaseAdmin
            .from("accounting_groups")
            .insert([req.body])
            .select()
            .single();

        if (error) throw error;

        return res.json({ success: true, data, message: "گروه با موفقیت ایجاد شد" });
    } catch (e) {
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

        const payload = { ...req.body };
        delete payload.id;
        delete payload.created_at;

        const { data, error } = await supabaseAdmin
            .from("accounting_groups")
            .update(payload)
            .eq("id", req.params.id)
            .select()
            .single();

        if (error) throw error;

        return res.json({ success: true, data, message: "گروه با موفقیت ویرایش شد" });
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

        const { error } = await supabaseAdmin
            .from("accounting_groups")
            .delete()
            .eq("id", req.params.id);

        if (error) {
            if (error.code === '23503') {
                return res.status(409).json({
                    success: false,
                    error: "امکان حذف وجود ندارد (دارای کل وابسته)"
                });
            }
            throw error;
        }

        return res.json({ success: true, message: "گروه با موفقیت حذف شد" });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;