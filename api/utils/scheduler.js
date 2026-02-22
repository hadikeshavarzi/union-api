const { pool } = require("../../supabaseAdmin");
const { sendSms, getFormSettings } = require("./sms");

async function getWarehouseName(memberId) {
  try {
    const { rows } = await pool.query(
      "SELECT warehouse_name FROM warehouse_settings WHERE member_id = $1", [memberId]
    );
    return rows[0]?.warehouse_name || "انبار";
  } catch { return "انبار"; }
}

async function getMemberMobile(memberId) {
  try {
    const { rows } = await pool.query("SELECT mobile FROM members WHERE id = $1", [memberId]);
    return rows[0]?.mobile;
  } catch { return null; }
}

function toPersianDate(d) {
  try { return new Date(d).toLocaleDateString("fa-IR"); } catch { return String(d); }
}

function fmtAmt(n) {
  return Number(n).toLocaleString("fa-IR");
}

async function checkPayableChequeDueDates() {
  console.log("⏰ Checking payable cheque due dates...");
  try {
    const today = new Date().toISOString().slice(0, 10);
    const threeDaysLater = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);

    const { rows } = await pool.query(`
      SELECT c.*, m.mobile AS member_mobile
      FROM treasury_checks c
      LEFT JOIN members m ON m.id = c.member_id
      WHERE c.type = 'payable'
        AND c.status = 'issued'
        AND c.due_date IS NOT NULL
        AND c.due_date::date BETWEEN $1::date AND $2::date
        AND (c.last_sms_reminder IS NULL OR c.last_sms_reminder::date < $1::date)
    `, [today, threeDaysLater]);

    console.log(`  Found ${rows.length} payable cheques due soon`);

    for (const chk of rows) {
      if (!chk.member_mobile) continue;

      const warehouseName = await getWarehouseName(chk.member_id);
      const receiverTitle = chk.description || "";
      const isToday = chk.due_date.toISOString?.().slice(0, 10) === today || String(chk.due_date).slice(0, 10) === today;

      const text =
        `${warehouseName}\n` +
        `${isToday ? "⚠️ امروز" : "🔔 یادآوری"} سررسید چک پرداختنی:\n` +
        `شماره چک: ${chk.cheque_no || "-"}\n` +
        `مبلغ: ${fmtAmt(chk.amount)} ریال\n` +
        `سررسید: ${toPersianDate(chk.due_date)}\n` +
        `${chk.bank_name ? "بانک: " + chk.bank_name : ""}\n` +
        `${receiverTitle}`;

      const sent = await sendSms(chk.member_mobile, text.trim());
      if (sent) {
        await pool.query(
          "UPDATE treasury_checks SET last_sms_reminder = NOW() WHERE id = $1",
          [chk.id]
        ).catch(() => {});
      }
    }
  } catch (e) {
    console.error("❌ Payable cheque reminder error:", e.message);
  }
}

async function checkRentalDueDates() {
  console.log("⏰ Checking rental due dates...");
  try {
    const today = new Date();
    const { rows: rentals } = await pool.query(`
      SELECT r.*, c.name AS customer_name, c.mobile AS customer_mobile,
             m.mobile AS member_mobile
      FROM warehouse_rentals r
      LEFT JOIN customers c ON c.id = r.customer_id
      LEFT JOIN members m ON m.id = r.member_id
      WHERE r.status = 'active'
    `);

    console.log(`  Found ${rentals.length} active rentals`);

    for (const rental of rentals) {
      const cycle = rental.billing_cycle || "monthly";
      let nextDue;

      if (rental.last_invoiced_at) {
        nextDue = new Date(rental.last_invoiced_at);
        if (cycle === "yearly") nextDue.setFullYear(nextDue.getFullYear() + 1);
        else nextDue.setMonth(nextDue.getMonth() + 1);
      } else {
        nextDue = new Date(rental.start_date);
        if (cycle === "yearly") nextDue.setFullYear(nextDue.getFullYear() + 1);
        else nextDue.setMonth(nextDue.getMonth() + 1);
      }

      const daysUntilDue = Math.floor((nextDue - today) / 86400000);

      if (daysUntilDue > 3 || daysUntilDue < -1) continue;

      const warehouseName = await getWarehouseName(rental.member_id);
      const cycleLabel = cycle === "yearly" ? "سالانه" : "ماهانه";
      const isToday = daysUntilDue === 0;
      const isPast = daysUntilDue < 0;

      if (rental.member_mobile) {
        const ownerText =
          `${warehouseName}\n` +
          `${isPast ? "⚠️ سررسید گذشته" : isToday ? "⚠️ امروز سررسید" : "🔔 یادآوری سررسید"} اجاره:\n` +
          `مستاجر: ${rental.customer_name || "-"}\n` +
          `محل: ${rental.location_name || "-"}\n` +
          `مبلغ ${cycleLabel}: ${fmtAmt(rental.monthly_rent)} ریال\n` +
          `سررسید: ${toPersianDate(nextDue)}`;

        await sendSms(rental.member_mobile, ownerText);
      }

      if (rental.customer_mobile) {
        const custText =
          `مشتری گرامی ${rental.customer_name || ""}\n` +
          `${isPast ? "سررسید اجاره گذشته است" : isToday ? "امروز سررسید اجاره شما است" : "یادآوری سررسید اجاره"}:\n` +
          `محل: ${rental.location_name || "-"}\n` +
          `مبلغ: ${fmtAmt(rental.monthly_rent)} ریال\n` +
          `سررسید: ${toPersianDate(nextDue)}\n` +
          `\n${warehouseName}`;

        await sendSms(rental.customer_mobile, custText);
      }
    }
  } catch (e) {
    console.error("❌ Rental reminder error:", e.message);
  }
}

async function runDailyReminders() {
  console.log("\n====== Daily SMS Reminders ======");
  console.log("Time:", new Date().toLocaleString("fa-IR"));
  await checkPayableChequeDueDates();
  await checkRentalDueDates();
  console.log("====== Done ======\n");
}

function startScheduler() {
  const now = new Date();
  const next8am = new Date(now);
  next8am.setHours(8, 0, 0, 0);
  if (now >= next8am) next8am.setDate(next8am.getDate() + 1);

  const msUntil8am = next8am - now;
  console.log(`📅 SMS Scheduler: next run at 8:00 AM (in ${Math.round(msUntil8am / 60000)} min)`);

  setTimeout(() => {
    runDailyReminders();
    setInterval(runDailyReminders, 24 * 60 * 60 * 1000);
  }, msUntil8am);
}

module.exports = { startScheduler, runDailyReminders };
