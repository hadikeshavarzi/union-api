// api/routes/auth.js
const express = require("express");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const { pool } = require("../../supabaseAdmin");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

// ۱. تابع استانداردسازی موبایل (برای جلوگیری از تضاد شماره‌ها)
function normalizeMobile(m) {
    if (!m) return null;
    let x = String(m).trim().replace(/\s+/g, "");
    if (x.startsWith("+98")) x = "0" + x.slice(3);
    if (x.startsWith("98")) x = "0" + x.slice(2);
    if (x.length === 10 && x.startsWith("9")) x = "0" + x;
    return x;
}

// لیست دسترسی‌های کامل (برای جلوگیری از کرش کردن سایدبار فرانت‌ند)
const FULL_PERMISSIONS = [
    "dashboard.view", "product.view", "product.create", "category.view",
    "customer.view", "inventory.view", "receipt.view", "report.view", "setting.view"
];

// ---------------------------------------------------------
// مسیر ۱: درخواست کد تایید (OTP)
// ---------------------------------------------------------
router.post("/request-otp", async (req, res) => {
    try {
        const { mobile } = req.body;
        const cleanMobile = normalizeMobile(mobile);

        if (!cleanMobile) return res.status(400).json({ success: false, error: "شماره موبایل نامعتبر است" });

        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        const checkUser = await pool.query(`SELECT id FROM public.members WHERE mobile = $1`, [cleanMobile]);
        if (checkUser.rows.length === 0) {
            return res.status(404).json({ success: false, error: "کاربری با این شماره یافت نشد" });
        }

        await pool.query(
            `UPDATE public.members SET otp_code = $1, otp_expires = NOW() + interval '2 minutes' WHERE mobile = $2`,
            [otp, cleanMobile]
        );

        console.log(`📨 OTP for ${cleanMobile}: ${otp}`);

        const smsUser = process.env.MELIPAYAMAK_USERNAME;
        const smsPass = process.env.MELIPAYAMAK_PASSWORD;
        const smsFrom = process.env.SMS_SENDER_NUMBER;
        if (smsUser && smsPass && smsFrom) {
            try {
                const smsResp = await axios.post("https://rest.payamak-panel.com/api/SendSMS/SendSMS", {
                    username: smsUser,
                    password: smsPass,
                    to: cleanMobile,
                    from: smsFrom,
                    text: `سامانه مدیریت انبار\nکد ورود شما: ${otp}`,
                    isflash: false,
                }, { timeout: 15000, proxy: false });
                console.log(`✅ SMS sent to ${cleanMobile}:`, JSON.stringify(smsResp.data));
            } catch (smsErr) {
                console.error(`❌ SMS Error for ${cleanMobile}:`, smsErr.response?.data || smsErr.message);
            }
        }

        res.json({ success: true, message: "کد تایید ارسال شد" });

    } catch (error) {
        console.error("Request OTP Error:", error);
        res.status(500).json({ success: false, error: "خطای سرور" });
    }
});

// ---------------------------------------------------------
// مسیر ۲: تایید کد و ورود (مهم‌ترین بخش برای فرانت‌ند)
// ---------------------------------------------------------
router.post("/verify-otp", async (req, res) => {
    try {
        const { mobile, otp } = req.body;
        const cleanMobile = normalizeMobile(mobile);

        const { rows } = await pool.query(
            `SELECT * FROM public.members WHERE mobile = $1 AND otp_code = $2 LIMIT 1`,
            [cleanMobile, otp]
        );

        const user = rows[0];

        if (!user) {
            return res.status(400).json({ success: false, error: "کد تایید اشتباه است" });
        }

        // بررسی انقضا
        if (user.otp_expires && new Date() > new Date(user.otp_expires)) {
            return res.status(400).json({ success: false, error: "کد منقضی شده است" });
        }

        // پاکسازی OTP
        await pool.query(`UPDATE public.members SET otp_code = NULL, otp_expires = NULL WHERE id = $1`, [user.id]);

        // تولید توکن JWT
        const token = jwt.sign(
            { id: user.id, role: user.role, mobile: user.mobile, owner_id: user.owner_id },
            process.env.JWT_SECRET,
            { expiresIn: "24h" }
        );

        // آماده‌سازی دسترسی‌ها
        let perms = user.permissions;
        if (!perms || perms.length === 0) perms = FULL_PERMISSIONS;

        // ✅ پاسخ هوشمند: ارسال هر دو نام توکن (token و access_token)
        // برای هماهنگی کامل با Authmiddleware و api.js
        res.json({
            success: true,
            token: token,
            access_token: token,
            user: {
                id: user.id,
                full_name: user.full_name || "کاربر سیستم",
                role: user.role || "admin",
                mobile: user.mobile,
                member_code: user.member_code,
                permissions: perms,
                owner_id: user.owner_id
            },
            message: "ورود موفقیت‌آمیز"
        });

    } catch (error) {
        console.error("Verify OTP Error:", error);
        res.status(500).json({ success: false, error: "خطای سرور" });
    }
});

// ---------------------------------------------------------
// مسیر ۳: دریافت اطلاعات کاربر فعلی (برای رفرش شدن صفحه)
// ---------------------------------------------------------
router.get("/me", authMiddleware, async (req, res) => {
    try {
        // اطلاعات از میدلویر auth استخراج شده و در req.user قرار دارد
        if (!req.user) {
            return res.status(401).json({ success: false, error: "عدم دسترسی" });
        }

        let perms = req.user.permissions;
        if (!perms || perms.length === 0) perms = FULL_PERMISSIONS;

        res.json({
            success: true,
            user: {
                id: req.user.id,
                full_name: req.user.full_name,
                role: req.user.role || "admin",
                mobile: req.user.mobile,
                member_code: req.user.member_code,
                permissions: perms,
                owner_id: req.user.owner_id
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: "خطای داخلی سرور" });
    }
});

module.exports = router;