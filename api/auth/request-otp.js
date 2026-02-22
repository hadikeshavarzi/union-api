const express = require("express");
const { pool } = require("../../supabaseAdmin");
const axios = require("axios");

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const { mobile } = req.body;

    if (!mobile) {
      return res.status(400).json({ success: false, error: "شماره موبایل الزامی است" });
    }

    const { rows } = await pool.query(
      "SELECT * FROM members WHERE mobile = $1 LIMIT 1",
      [mobile]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, error: "عضوی با این شماره یافت نشد" });
    }

    const member = rows[0];
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();

    await pool.query(
      "UPDATE members SET otp_code = $1, otp_expires = $2, updated_at = NOW() WHERE id = $3",
      [otp, expiresAt, member.id]
    );

    console.log(`📨 OTP for ${mobile}: ${otp}`);

    const username = process.env.MELIPAYAMAK_USERNAME;
    const password = process.env.MELIPAYAMAK_PASSWORD;
    const from = process.env.SMS_SENDER_NUMBER;

    if (username && password && from) {
      try {
        const smsResponse = await axios.post(
          "https://rest.payamak-panel.com/api/SendSMS/SendSMS",
          {
            username: username,
            password: password,
            to: mobile,
            from: from,
            text: `کد ورود شما: ${otp}\nسامانه مدیریت انبار`,
            isflash: false,
          },
          { timeout: 15000, proxy: false }
        );
        console.log(`✅ SMS API Response for ${mobile}:`, JSON.stringify(smsResponse.data));
      } catch (smsErr) {
        console.error(`❌ SMS Error for ${mobile}:`, smsErr.response?.data || smsErr.message);
      }
    } else {
      console.warn("⚠️ SMS credentials missing - username:", !!username, "password:", !!password, "from:", !!from);
    }

    return res.json({ success: true, message: "کد یک‌بار مصرف ارسال شد" });

  } catch (err) {
    console.error("❌ REQUEST OTP ERROR:", err);
    return res.status(500).json({ success: false, error: "خطای داخلی سرور" });
  }
});

module.exports = router;
