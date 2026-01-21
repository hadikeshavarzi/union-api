// api/treasury/checks.js
const express = require("express");
const { supabaseAdmin } = require("../../supabaseAdmin");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

/* GET ALL CHECKS */
router.get("/", authMiddleware, async (req, res) => {
    try {
        const { type, status } = req.query;
        const member_id = req.user.id;

        let query = supabaseAdmin
            .from("treasury_checks")
            .select(`
                *,
                owner:accounting_tafsili!owner_id(id, title),
                receiver:accounting_tafsili!receiver_id(id, title)
            `)
            .eq("member_id", member_id)
            .order("created_at", { ascending: false });

        if (type) query = query.eq("type", type);
        if (status) query = query.eq("status", status);

        const { data, error } = await query;

        if (error) throw error;

        return res.json({ success: true, data: data || [] });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* GET ONE CHECK */
router.get("/:id", authMiddleware, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from("treasury_checks")
            .select("*")
            .eq("id", req.params.id)
            .eq("member_id", req.user.id)
            .single();

        if (error || !data) {
            return res.status(404).json({ success: false, error: "چک یافت نشد" });
        }

        return res.json({ success: true, data });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* Check Operations - Deposit */
router.post("/deposit", authMiddleware, async (req, res) => {
    res.json({ success: true, message: "قابلیت به زودی اضافه می‌شود" });
});

/* Check Operations - Clear */
router.post("/clear", authMiddleware, async (req, res) => {
    res.json({ success: true, message: "قابلیت به زودی اضافه می‌شود" });
});

/* Check Operations - Spend */
router.post("/spend", authMiddleware, async (req, res) => {
    res.json({ success: true, message: "قابلیت به زودی اضافه می‌شود" });
});

/* Check Operations - Bounce */
router.post("/bounce", authMiddleware, async (req, res) => {
    res.json({ success: true, message: "قابلیت به زودی اضافه می‌شود" });
});

module.exports = router;