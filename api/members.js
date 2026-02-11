const express = require("express");
const router = express.Router();
const { pool } = require("../supabaseAdmin"); 
const auth = require("./middleware/auth");

// ==========================================
// 1. دریافت لیست اعضا (این همان روت گمشده است)
// ==========================================
router.get("/list", auth, async (req, res) => {
    try {
        // دریافت لیست تمام اعضا/کاربران برای اختصاص نقش
        const r = await pool.query(
            `SELECT id, role, full_name, company_name, mobile, email, member_code, member_status, created_at
             FROM public.members
             ORDER BY created_at DESC`
        );
        return res.json({ success: true, data: r.rows });
    } catch (e) {
        console.error("❌ Error in members/list:", e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

// ==========================================
// 2. دریافت کاربران سیستم (زیرمجموعه‌های یک مالک)
// ==========================================
router.get("/system-users", auth, async (req, res) => {
    try {
        const ownerId = req.user.id; 
        const r = await pool.query(
            `SELECT id, role, full_name, mobile, email, member_code, owner_id, permissions, member_status, created_at
             FROM public.members
             WHERE owner_id = $1
             ORDER BY created_at DESC`,
            [ownerId]
        );
        return res.json({ success: true, data: r.rows });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

// ==========================================
// 3. ایجاد کاربر جدید
// ==========================================
router.post("/system-users", auth, async (req, res) => {
    try {
        const ownerId = req.user.id;
        const body = req.body || {};

        if (!body.mobile) return res.status(400).json({ success: false, error: "شماره موبایل الزامی است" });
        if (!body.full_name) return res.status(400).json({ success: false, error: "نام و نام خانوادگی الزامی است" });

        const r = await pool.query(
            `INSERT INTO public.members
            (role, full_name, mobile, email, member_code, owner_id, permissions, member_status, created_at, updated_at)
            VALUES
            ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
            RETURNING id, role, full_name, mobile, email, member_code, owner_id, permissions, member_status, created_at`,
            [
                body.role || "employee",
                body.full_name,
                body.mobile,
                body.email || null,
                body.member_code || null,
                ownerId,
                body.permissions || [],
                body.member_status || "active",
            ]
        );

        return res.json({ success: true, data: r.rows[0] });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;