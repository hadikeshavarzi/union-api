const express = require("express");
const { pool } = require("../../supabaseAdmin");
const axios = require("axios");

const router = express.Router();

async function getWarehouseName(memberId) {
  if (!memberId) return "انبار";
  try {
    const { rows } = await pool.query(
      "SELECT warehouse_name FROM warehouse_settings WHERE member_id = $1", [memberId]
    );
    return rows[0]?.warehouse_name || "انبار";
  } catch { return "انبار"; }
}

function buildClearanceSmsText(customerName, otp, metadata, warehouseName) {
  const items = Array.isArray(metadata.items) ? metadata.items : [];
  const itemLines = items.map(it => {
    const parts = [];
    if (it.batch) parts.push(`ردیف: ${it.batch}`);
    parts.push(it.product || "کالا");
    if (it.qty) parts.push(`تعداد: ${Number(it.qty).toLocaleString("fa-IR")}`);
    if (it.weight) parts.push(`وزن: ${Number(it.weight).toLocaleString("fa-IR")}`);
    return parts.join(" | ");
  }).join("\n");

  let text = `مشتری گرامی ${customerName}\n`;
  text += `کالا با مشخصات زیر ترخیص میشود:\n`;
  if (itemLines) text += `${itemLines}\n`;
  if (metadata.receiverName) text += `نام طرف: ${metadata.receiverName}\n`;
  if (metadata.receiverNationalId) text += `کد ملی: ${metadata.receiverNationalId}\n`;
  if (metadata.plate) text += `پلاک: ${metadata.plate}\n`;
  text += `کد تایید: ${otp}\n`;
  text += `به منزله اطلاع کامل از ترخیص کالا میباشد.\n`;
  text += warehouseName;

  return text;
}

router.post("/", async (req, res) => {
  try {
    const { mobile, metadata } = req.body;

    if (!mobile) {
      return res.status(400).json({ success: false, error: "شماره موبایل الزامی است" });
    }

    const { rows } = await pool.query(
      "SELECT c.id, c.name, c.mobile, c.member_id FROM public.customers c WHERE c.mobile = $1 LIMIT 1",
      [mobile]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, error: "مشتری با این شماره موبایل یافت نشد" });
    }

    const customer = rows[0];
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await pool.query(
      "UPDATE public.customers SET otp_code = $1, otp_expires = $2 WHERE id = $3",
      [otp, expiresAt, customer.id]
    );

    console.log(`📨 Customer OTP for ${customer.name} (${mobile}): ${otp}`);

    const username = process.env.MELIPAYAMAK_USERNAME;
    const password = process.env.MELIPAYAMAK_PASSWORD;
    const from = process.env.SMS_SENDER_NUMBER;

    if (username && password && from) {
      try {
        let smsText;

        if (metadata?.type === "clearance") {
          const warehouseName = await getWarehouseName(customer.member_id);
          smsText = buildClearanceSmsText(customer.name, otp, metadata, warehouseName);
        } else {
          smsText = `${customer.name} عزیز\nکد تایید: ${otp}\nسامانه مدیریت انبار`;
          if (metadata?.product) smsText += `\nکالا: ${metadata.product}`;
        }

        const smsResponse = await axios.post(
          "https://rest.payamak-panel.com/api/SendSMS/SendSMS",
          {
            username, password,
            to: mobile, from,
            text: smsText,
            isflash: false,
          },
          { timeout: 15000, proxy: false }
        );
        console.log(`✅ Customer SMS sent to ${mobile}:`, JSON.stringify(smsResponse.data));
      } catch (smsErr) {
        console.error(`❌ Customer SMS Error for ${mobile}:`, smsErr.response?.data || smsErr.message);
      }
    } else {
      console.warn("⚠️ SMS credentials missing");
    }

    return res.json({
      success: true,
      status: 200,
      message: "کد تایید ارسال شد",
    });

  } catch (err) {
    console.error("❌ CUSTOMER OTP ERROR:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
