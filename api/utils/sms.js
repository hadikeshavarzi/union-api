const axios = require("axios");
const { pool } = require("../../supabaseAdmin");

const SMS_API_URL = "https://rest.payamak-panel.com/api/SendSMS/SendSMS";

async function sendSms(to, text) {
  const username = process.env.MELIPAYAMAK_USERNAME;
  const password = process.env.MELIPAYAMAK_PASSWORD;
  const from = process.env.SMS_SENDER_NUMBER;

  if (!username || !password || !from) return false;

  const cleanMobile = String(to).replace(/\s/g, "");
  if (!/^09\d{9}$/.test(cleanMobile)) return false;

  try {
    const resp = await axios.post(SMS_API_URL, {
      username, password, to: cleanMobile, from, text, isflash: false,
    }, { timeout: 15000, proxy: false });
    console.log(`✅ SMS → ${cleanMobile}: ${JSON.stringify(resp.data?.RetStatus)}`);
    return true;
  } catch (err) {
    console.error(`❌ SMS → ${cleanMobile}:`, err.response?.data || err.message);
    return false;
  }
}

async function getFormSettings(memberId) {
  try {
    const { rows } = await pool.query(
      "SELECT form_settings FROM warehouse_settings WHERE member_id = $1", [memberId]
    );
    if (!rows.length || !rows[0].form_settings) return null;
    return typeof rows[0].form_settings === "string"
      ? JSON.parse(rows[0].form_settings) : rows[0].form_settings;
  } catch { return null; }
}

async function getWarehouseName(memberId) {
  try {
    const { rows } = await pool.query(
      "SELECT warehouse_name FROM warehouse_settings WHERE member_id = $1", [memberId]
    );
    return rows[0]?.warehouse_name || "انبار";
  } catch { return "انبار"; }
}

async function getCustomerInfo(customerId) {
  try {
    const { rows } = await pool.query(
      "SELECT id, name, mobile, national_id FROM customers WHERE id = $1", [customerId]
    );
    return rows[0] || {};
  } catch { return {}; }
}

async function getMemberMobile(memberId) {
  try {
    const { rows } = await pool.query("SELECT mobile FROM members WHERE id = $1", [memberId]);
    return rows[0]?.mobile;
  } catch { return null; }
}

function buildItemLines(items) {
  return items.map(it => {
    const parts = [];
    if (it.productName) parts.push(it.productName);
    if (it.qty) parts.push(`تعداد: ${it.qty}`);
    if (it.weight) parts.push(`وزن خالص: ${it.weight} کیلو`);
    if (it.batchNo) parts.push(`ردیف: ${it.batchNo}`);
    return parts.join(" | ");
  }).join("\n");
}

async function sendReceiptSms({ memberId, receiptNo, customerId, items, docDate }) {
  const fs = await getFormSettings(memberId);
  if (!fs?.receipt?.notifyCustomer) return;

  const cust = await getCustomerInfo(customerId);
  if (!cust.mobile) return;

  const warehouseName = await getWarehouseName(memberId);
  const itemLines = buildItemLines(items);

  const text =
    `مشتری گرامی ${cust.name || ""}\n` +
    `رسید کالا با مشخصات زیر ثبت شد:\n` +
    `${itemLines}\n` +
    `\n${warehouseName}`;

  await sendSms(cust.mobile, text);

  if (fs.receipt.notifyOwner) {
    const ownerMobile = await getMemberMobile(memberId);
    if (ownerMobile) {
      await sendSms(ownerMobile,
        `رسید شماره ${receiptNo} برای ${cust.name || "مشتری"} در تاریخ ${docDate || ""} ثبت شد.\n${warehouseName}`
      );
    }
  }
}

async function sendExitSms({ memberId, exitNo, customerId, items, docDate }) {
  const fs = await getFormSettings(memberId);
  if (!fs?.exit?.notifyCustomer) return;

  const cust = await getCustomerInfo(customerId);
  if (!cust.mobile) return;

  const warehouseName = await getWarehouseName(memberId);
  const itemLines = buildItemLines(items);

  const text =
    `مشتری گرامی ${cust.name || ""}\n` +
    `خروجی کالا با مشخصات زیر ثبت شد:\n` +
    `${itemLines}\n` +
    `\n${warehouseName}`;

  await sendSms(cust.mobile, text);

  if (fs.exit.notifyOwner) {
    const ownerMobile = await getMemberMobile(memberId);
    if (ownerMobile) {
      await sendSms(ownerMobile,
        `خروجی شماره ${exitNo} برای ${cust.name || "مشتری"} در تاریخ ${docDate || ""} ثبت شد.\n${warehouseName}`
      );
    }
  }
}

async function sendClearanceSms({ memberId, customerId, items, receiverName, receiverNationalId, plate }) {
  const fs = await getFormSettings(memberId);
  if (!fs?.clearance?.notifyCustomer) return;

  const cust = await getCustomerInfo(customerId);
  if (!cust.mobile) return;

  const warehouseName = await getWarehouseName(memberId);

  const otp = Math.floor(100000 + Math.random() * 900000).toString();

  const itemLines = items.map(it => {
    const parts = [];
    if (it.batchNo) parts.push(`ردیف: ${it.batchNo}`);
    if (it.productName) parts.push(it.productName);
    if (it.qty) parts.push(`تعداد: ${it.qty}`);
    if (it.weight) parts.push(`وزن: ${it.weight}`);
    return parts.join(" | ");
  }).join("\n");

  let receiverInfo = "";
  if (receiverName) receiverInfo += `نام طرف: ${receiverName}\n`;
  if (receiverNationalId) receiverInfo += `کد ملی: ${receiverNationalId}\n`;
  if (plate) receiverInfo += `پلاک: ${plate}\n`;

  const text =
    `مشتری گرامی ${cust.name || ""}\n` +
    `کالا با مشخصات زیر ترخیص میشود:\n` +
    `${itemLines}\n` +
    `${receiverInfo}` +
    `کد تایید: ${otp}\n` +
    `به منزله اطلاع کامل از ترخیص کالا میباشد.\n` +
    `\n${warehouseName}`;

  await sendSms(cust.mobile, text);

  return otp;
}

async function sendRentalSms({ memberId, customerId, locationName, monthlyRent, startDate, billingCycle }) {
  const fs = await getFormSettings(memberId);
  if (!fs?.rental?.notifyCustomer) return;

  const cust = await getCustomerInfo(customerId);
  if (!cust.mobile) return;

  const warehouseName = await getWarehouseName(memberId);
  const cycleLabel = billingCycle === "yearly" ? "سالانه" : "ماهانه";
  const rentFormatted = Number(monthlyRent).toLocaleString("fa-IR");

  const text =
    `مشتری گرامی ${cust.name || ""}\n` +
    `قرارداد اجاره انبار با مشخصات زیر ثبت شد:\n` +
    `محل: ${locationName || "-"}\n` +
    `مبلغ اجاره ${cycleLabel}: ${rentFormatted} ریال\n` +
    `تاریخ شروع: ${startDate || "-"}\n` +
    `\n${warehouseName}`;

  await sendSms(cust.mobile, text);
}

module.exports = {
  sendSms,
  sendReceiptSms,
  sendExitSms,
  sendClearanceSms,
  sendRentalSms,
  getFormSettings,
};
