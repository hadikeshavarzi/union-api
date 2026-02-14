const express = require("express");
const { pool } = require("../../supabaseAdmin");
const axios = require("axios");

const router = express.Router();

router.post("/", async (req, res) => {
  console.log("==================================================");
  console.log("🔵 CUSTOMER OTP REQUEST");
  console.log("📥 Body:", req.body);
  console.log("==================================================");

  try {
    const { mobile, metadata } = req.body;

    if (!mobile) {
      return res.status(400).json({
        success: false,
        error: "شماره موبایل الزامی است",
      });
    }

    console.log("🔍 Searching customer with mobile:", mobile);

    const { rows } = await pool.query(
      `SELECT id, name, mobile 
       FROM public.customers 
       WHERE mobile = $1 
       LIMIT 1`,
      [mobile]
    );

    console.log("📊 Query result:", rows);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "مشتری با این شماره موبایل یافت نشد",
      });
    }

    const customer = rows[0];
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await pool.query(
      `UPDATE public.customers 
       SET otp_code = $1, otp_expires = $2
       WHERE id = $3`,
      [otp, expiresAt, customer.id]
    );

    console.log(`✅ OTP Generated: ${otp} for ${customer.name}`);

    if (process.env.MELIPAYAMAK_USERNAME) {
      try {
        let smsText = `${customer.name} عزیز\nکد تایید: ${otp}\n`;
        if (metadata?.product) smsText += `کالا: ${metadata.product}`;

        await axios.post("https://rest.payamak-panel.com/api/SendSMS/SendSMS", {
          username: process.env.MELIPAYAMAK_USERNAME,
          password: process.env.MELIPAYAMAK_PASSWORD,
          to: mobile,
          from: process.env.SMS_SENDER_NUMBER,
          text: smsText,
          isflash: false,
        });
      } catch (smsErr) {
        console.error("SMS Error:", smsErr.message);
      }
    }

    return res.json({
      success: true,
      status: 200,
      message: "کد تایید ارسال شد",
      ...(process.env.NODE_ENV === 'development' && { debug_otp: otp })
    });

  } catch (err) {
    console.error("❌ ERROR:", err);
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

module.exports = router;