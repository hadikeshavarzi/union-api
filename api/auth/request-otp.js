// api/auth/request-otp.js (CommonJS)
const express = require("express");
const { pool, supabaseAdmin } = require("../../supabaseAdmin");
const axios = require("axios");

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const { mobile } = req.body;

    if (!mobile) {
      return res.status(400).json({
        success: false,
        error: "شماره موبایل الزامی است",
      });
    }

    const { data: member, error } = await supabaseAdmin
        .from("members")
        .select("*")
        .eq("mobile", mobile)
        .single();

    if (error || !member) {
      return res.status(404).json({
        success: false,
        error: "عضوی با این شماره یافت نشد",
      });
    }

    // ساخت OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();

    // ذخیره OTP
    await supabaseAdmin
        .from("members")
        .update({
          otp_code: otp,
          otp_expires: expiresAt,
          updated_at: new Date().toISOString(),
        })
        .eq("id", member.id);

    console.log(`📨 OTP for ${mobile}: ${otp}`);

    // ارسال پیامک
    if (process.env.MELIPAYAMAK_USERNAME) {
      try {
        await axios.post("https://rest.payamak-panel.com/api/SendSMS/SendSMS", {
          username: process.env.MELIPAYAMAK_USERNAME,
          password: process.env.MELIPAYAMAK_PASSWORD,
          to: mobile,
          from: process.env.SMS_SENDER_NUMBER,
          text: `کد ورود شما: ${otp}`,
          isflash: false,
        });
      } catch (smsErr) {
        console.error("SMS Error:", smsErr.message);
      }
    }

    return res.json({
      success: true,
      message: "کد یک‌بار مصرف ارسال شد",
    });

  } catch (err) {
    console.error("❌ REQUEST OTP ERROR:", err);
    return res.status(500).json({
      success: false,
      error: "خطای داخلی سرور",
    });
  }
});

module.exports = router;