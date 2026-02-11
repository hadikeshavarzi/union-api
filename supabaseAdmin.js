// supabaseAdmin.js - نسخه نهایی و اصلاح‌شده
require('dotenv').config(); // ✅ لود کردن فایل .env (خیلی مهم)
const { Pool } = require("pg");

// ۱. بررسی وجود متغیر محیطی
if (!process.env.DATABASE_URL) {
    console.error("❌ Fatal Error: DATABASE_URL is not defined in .env");
    process.exit(1);
}

// لاگ اتصال (با سانسور پسورد)
console.log("🔌 Init DB Connection:", process.env.DATABASE_URL.replace(/:[^:@]+@/, ":****@"));

// ۲. تنظیمات Pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // اگر روی لوکال هستید ssl معمولا باید false باشد مگر اینکه تنظیم کرده باشید
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    max: 20, // حداکثر تعداد کانکشن همزمان
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});

// ۳. عملیات مچ‌گیری (تشخیص دقیق سرور متصل شده)
pool.connect((err, client, release) => {
    if (err) {
        console.error("\n❌❌❌ CONNECTION ERROR ❌❌❌");
        console.error("Message:", err.message);
        console.error("Hint: آیا پورت 5432 باز است؟ آیا پسورد درست است؟\n");
    } else {
        // اجرای کوئری برای گرفتن اطلاعات دقیق سرور
        client.query("SELECT inet_server_addr() as ip, inet_server_port() as port, current_database() as db, version() as ver", (qErr, res) => {
            release(); // ✅ کانکشن را آزاد می‌کنیم تا در Pool بماند

            if (qErr) {
                console.error("❌ Query Failed:", qErr.message);
            } else {
                const info = res.rows[0];
                console.log("\n========================================");
                console.log("✅ POSTGRES CONNECTED SUCCESSFULLY!");
                console.log(`🌍 Server IP:   ${info.ip || 'Localhost/Socket'}`);
                console.log(`🚪 Port:        ${info.port}`);
                console.log(`🗄️  Database:    ${info.db}`);
                console.log(`ℹ️  Version:     ${info.ver.split(' ')[1]}`); // فقط شماره نسخه
                console.log("========================================\n");
            }
        });
    }
});

// ۴. اکسپورت دوگانه (برای سازگاری با کدهای قدیمی و جدید)
module.exports = {
    pool,
    supabaseAdmin: pool // ✅ این خط باعث می‌شود فایل‌هایی که هنوز supabaseAdmin را صدا می‌زنند خراب نشوند
};