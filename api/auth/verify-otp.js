// api/auth/verify-otp.js (CommonJS)
const express = require("express");
const jwt = require("jsonwebtoken");
const { supabaseAdmin } = require("../../supabaseAdmin");

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const { mobile, otp } = req.body;

    if (!mobile || !otp) {
      return res.status(400).json({
        success: false,
        error: "شماره موبایل و کد تأیید الزامی است",
      });
    }

    // پیدا کردن عضو
    const { data: member, error } = await supabaseAdmin
        .from("members")
        .select("*")
        .eq("mobile", mobile)
        .eq("otp_code", otp)
        .single();

    if (error || !member) {
      return res.status(400).json({
        success: false,
        error: "کد تأیید صحیح نیست",
      });
    }

    // بررسی انقضا
    if (new Date() > new Date(member.otp_expires)) {
      return res.status(400).json({
        success: false,
        error: "کد منقضی شده است",
      });
    }

    // پاک کردن OTP
    await supabaseAdmin
        .from("members")
        .update({
          otp_code: null,
          otp_expires: null,
        })
        .eq("id", member.id);

    // ساخت JWT
    const token = jwt.sign(
        {
          id: member.id,
          role: member.role || "member",
          mobile: member.mobile,
        },
        process.env.JWT_SECRET,
        { expiresIn: "24h" }
    );

    // حذف فیلدهای حساس
    const safeUser = {
      id: member.id,
      full_name: member.full_name,
      mobile: member.mobile,
      role: member.role,
      member_code: member.member_code,
      category: member.category,
      national_id: member.national_id,
      business_name: member.business_name,
    };

    console.log("✅ Login successful for:", mobile);

    return res.json({
      success: true,
      token,
      user: safeUser,
      message: "ورود موفق",
    });

  } catch (err) {
    console.error("❌ VERIFY OTP ERROR:", err);
    return res.status(500).json({
      success: false,
      error: "خطای سرور",
    });
  }
});

module.exports = router;