const express = require("express");
const jwt = require("jsonwebtoken");
const { pool } = require("../../supabaseAdmin");

const router = express.Router();

router.post("/", async (req, res) => {
  console.log("==================================================");
  console.log("🔐 CUSTOMER OTP VERIFY");
  console.log("📥 Body:", req.body);
  console.log("==================================================");

  try {
    const { mobile, otp } = req.body;

    if (!mobile || !otp) {
      return res.status(400).json({ 
        success: false, 
        error: "شماره و کد الزامی است" 
      });
    }

    const { rows } = await pool.query(
      `SELECT id, name, mobile, otp_code, otp_expires
       FROM public.customers 
       WHERE mobile = $1 
       LIMIT 1`,
      [mobile]
    );

    if (rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: "مشتری یافت نشد" 
      });
    }

    const customer = rows[0];

    if (!customer.otp_code || customer.otp_code !== otp) {
      console.log("❌ Wrong OTP. Expected:", customer.otp_code, "Got:", otp);
      return res.status(400).json({ 
        success: false, 
        error: "کد اشتباه است" 
      });
    }

    if (customer.otp_expires && new Date() > new Date(customer.otp_expires)) {
      return res.status(400).json({ 
        success: false, 
        error: "کد منقضی شده" 
      });
    }

    await pool.query(
      `UPDATE public.customers 
       SET otp_code = NULL, otp_expires = NULL 
       WHERE id = $1`,
      [customer.id]
    );

    const verificationToken = jwt.sign(
      {
        customer_id: customer.id,
        mobile: customer.mobile,
        name: customer.name,
        verified_at: new Date().toISOString(),
      },
      process.env.JWT_SECRET,
      { expiresIn: "10m" }
    );

    console.log(`✅ Verified: ${customer.name}`);

    return res.json({
      success: true,
      status: 200,
      token: verificationToken,
      message: "تأیید موفق",
    });

  } catch (err) {
    console.error("❌ ERROR:", err);
    return res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

module.exports = router;