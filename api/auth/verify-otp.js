const express = require("express");
const jwt = require("jsonwebtoken");
const { pool } = require("../../supabaseAdmin");

const router = express.Router();

// لیست دسترسی‌های پیش‌فرض برای زمانی که دیتابیس خالی است
const DEFAULT_PERMISSIONS = [
  "dashboard.view",
  "client.portal",
  "member.view",
  "inventory.view",
  "receipt.view",
  "accounting.view"
];

/**
 * تابع کمکی برای تبدیل امن ID
 */
const ensureUUID = (id) => {
  if (!id) return null;
  const s = String(id);
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
  if (isUUID) return s;
  if (/^\d+$/.test(s)) {
    return `00000000-0000-0000-0000-${s.padStart(12, '0')}`;
  }
  return s;
};

router.post("/", async (req, res) => {
  try {
    const { mobile, otp } = req.body;

    if (!mobile || !otp) {
      return res.status(400).json({ success: false, error: "شماره موبایل و کد تأیید الزامی است" });
    }

    // ۱. دریافت اطلاعات کاربر
    const { rows } = await pool.query(
        `SELECT * FROM public.members WHERE mobile = $1 AND otp_code = $2 LIMIT 1`,
        [mobile, otp]
    );

    const member = rows[0];

    // ۲. بررسی وجود کاربر
    if (!member) {
      return res.status(400).json({ success: false, error: "کد تأیید صحیح نیست" });
    }

    // ۳. بررسی انقضای کد
    if (member.otp_expires && new Date() > new Date(member.otp_expires)) {
      return res.status(400).json({ success: false, error: "کد منقضی شده است" });
    }

    // ۴. هوشمندسازی ID
    const verifiedId = ensureUUID(member.id);
    const verifiedOwnerId = ensureUUID(member.owner_id) || verifiedId;

    // ۵. پاک کردن OTP
    await pool.query(
        `UPDATE public.members SET otp_code = NULL, otp_expires = NULL WHERE id = $1`,
        [member.id]
    );

    // ✅ ۶. مدیریت پرمیشن‌ها (بخش حیاتی که جا افتاده بود)
    let userPermissions = [];

    // اگر در دیتابیس آرایه ذخیره شده باشد
    if (Array.isArray(member.permissions)) {
      userPermissions = member.permissions;
    }
    // اگر استرینگ جیسون باشد
    else if (typeof member.permissions === 'string') {
      try {
        userPermissions = JSON.parse(member.permissions);
      } catch (e) {
        userPermissions = DEFAULT_PERMISSIONS;
      }
    }

    // اگر خالی بود، پیش‌فرض را بده
    if (!userPermissions || userPermissions.length === 0) {
      userPermissions = DEFAULT_PERMISSIONS;
    }

    // ۷. ساخت JWT (پرمیشن را هم داخل توکن بگذاریم خوب است)
    const token = jwt.sign(
        {
          id: verifiedId,
          role: member.role || "owner",
          mobile: member.mobile,
          owner_id: verifiedOwnerId,
          // permissions: userPermissions // اختیاری: اگر می‌خواهید توکن سنگین نشود کامنت کنید
        },
        process.env.JWT_SECRET,
        { expiresIn: "7d" }
    );

    // ۸. آماده‌سازی داده نهایی (حتماً پرمیشن باید باشد)
    const safeUser = {
      id: verifiedId,
      full_name: member.full_name || "کاربر گرامی",
      mobile: member.mobile,
      role: member.role || "owner",
      member_code: member.member_code,
      business_name: member.business_name,
      permissions: userPermissions // 👈 کلید حل مشکل اینجاست!
    };

    console.log(`✅ Login: ${mobile} | Role: ${safeUser.role} | Perms Count: ${safeUser.permissions.length}`);

    return res.json({
      success: true,
      token,
      access_token: token, // برای سازگاری بیشتر
      user: safeUser,
      message: "ورود موفقیت‌آمیز بود",
    });

  } catch (err) {
    console.error("❌ VERIFY OTP ERROR:", err);
    return res.status(500).json({ success: false, error: "خطای سرور" });
  }
});

module.exports = router;