// =======================================
//  union-api/server.js (FINAL & STABLE)
// =======================================

require('dotenv').config();

const express = require('express');
const cors = require('cors');

// ✅ اتصال به دیتابیس (فقط از منبع اصلی supabaseAdmin.js)
const { pool } = require("./supabaseAdmin");

// --- وارد کردن روت‌های اصلی ---
const authRoutes = require("./api/routes/auth");
const loadingRoutes = require('./api/loadings');
const exitRoutes = require('./api/exits');
const treasuryOpsRoutes = require('./api/treasury/operations');
const treasuryRoutes = require('./api/treasury/index');
const app = express();
const permissionsRoutes = require('./api/permissions.routes');
// =======================================
// تنظیمات اولیه و امنیتی
// =======================================
app.set('trust proxy', 1);

// تست زنده بودن دیتابیس در زمان استارت
(async () => {
    try {
        const r = await pool.query('SELECT 1 as ok');
        console.log('✅ Postgres connected successfully:', r.rows[0]);
    } catch (e) {
        console.error('❌ Postgres connection failed! Check DATABASE_URL in .env');
        console.error(e.message);
        process.exit(1);
    }
})();

// =======================================
// Middlewares
// =======================================
app.use(cors({
    origin: true, // اجازه به تمام مبداها برای تست
    credentials: true,
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// لاگ کردن ساده درخواست‌ها برای مانیتورینگ
app.use((req, res, next) => {
    console.log(`📥 ${req.method} ${req.path}`);
    next();
});

// =======================================
// تابع کمکی برای نصب روت‌ها (جلوگیری از کرش)
// =======================================
const mountRoute = (path, routerPath) => {
    try {
        // اگر routerPath یک رشته است، آن را require کن، وگرنه خود آبجکت را استفاده کن
        const routeHandler = typeof routerPath === 'string' ? require(routerPath) : routerPath;

        if (typeof routeHandler === 'function' || (routeHandler && typeof routeHandler.use === 'function')) {
            app.use(path, routeHandler);
            console.log(`✔️ Route mounted: ${path}`);
        } else {
            console.error(`⚠️ WARNING: Route at ${path} (file: ${routerPath}) is missing module.exports!`);
        }
    } catch (err) {
        // اگر فایل وجود نداشت، فقط لاگ بزن و برنامه را متوقف نکن
        console.error(`❌ ERROR loading route ${path}:`, err.message);
    }
};

app.use((req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth) {
    // فقط برای مسیرهایی که نیاز به لاگین دارند
    if (req.path.startsWith("/api/receipts") || req.path.startsWith("/api/treasury") || req.path.startsWith("/api/customers")) {
      console.log("⚠️ NO AUTH HEADER:", req.method, req.path);
    }
  } else {
    console.log("🔐 AUTH HEADER OK:", req.method, req.path);
  }
  next();
});

// =======================================
// ۳. نصب تمام روت‌ها (Routes Mounting)
// =======================================

// --- بخش احراز هویت ---
mountRoute("/api/auth", authRoutes);
mountRoute("/api/auth/customer-request-otp", "./api/auth/customer-request-otp");
mountRoute("/api/auth/customer-verify-otp", "./api/auth/customer-verify-otp");

// --- بخش انبارداری و کالا ---
mountRoute('/api/warehouse', './api/warehouse'); // ✅ اضافه شد برای رفع ارور داشبورد
mountRoute('/api/product-units', './api/productUnits');
mountRoute('/api/product-categories', './api/productCategories');
mountRoute('/api/media', './api/media');
mountRoute('/api/products', './api/products');
mountRoute('/api/customers', './api/customers');
mountRoute('/api/document-types', './api/documentTypes');
mountRoute('/api/receipts', './api/receipts');
mountRoute('/api/receipt-items', './api/receiptItems');
mountRoute('/api/inventory-transactions', './api/inventoryTransactions');
mountRoute('/api/inventory-stock', './api/inventoryStock');
mountRoute('/api/clearances', './api/clearances');
mountRoute('/api/clearance-items', './api/clearanceItems');

// --- بخش لجستیک ---
mountRoute('/api/loadings', loadingRoutes);
mountRoute('/api/exits', exitRoutes);

// --- بخش حسابداری ---
// نکته: گزارشات را قبل از روت اصلی حسابداری می‌گذاریم تا توسط آن خورده نشود
mountRoute('/api/accounting/reports', './api/accounting/reports'); // ✅ اضافه شد برای رفع ارور داشبورد

app.use('/api/accounting', require('./api/accounting/index'));
mountRoute('/api/accounting-groups', './api/accounting/groups');
mountRoute('/api/accounting-gl', './api/accounting/gl');
mountRoute('/api/accounting-moein', './api/accounting/moein');
mountRoute('/api/accounting-tafsili', './api/accounting/tafsili');
mountRoute('/api/accounting', './api/accounting/balance');

// --- بخش خزانه‌داری ---
mountRoute('/api/base-banks', './api/baseBanks');
mountRoute('/api/treasury-banks', './api/treasury/banks');
mountRoute('/api/treasury-cashes', './api/treasury/cashes');
mountRoute('/api/treasury-pos', './api/treasury/pos');
mountRoute('/api/treasury-checkbooks', './api/treasury/checkbooks');
mountRoute('/api/treasury-checks', './api/treasury/checks');
mountRoute('/api/treasury', treasuryOpsRoutes);
app.use('/api/treasury', treasuryRoutes);
// --- گزارشات کلی و اعضا ---
mountRoute('/api/reports', './api/reports/index');
mountRoute("/api/members", "./api/members");


//permission 

app.use('/api/permissions', permissionsRoutes);

//====================================
// ۴. مدیریت نهایی
// =======================================

// مسیر سلامت سیستم
app.get('/api/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// مدیریت مسیرهای ناشناخته (404)
app.use((req, res) => {
    res.status(404).json({ success: false, error: `مسیر مورد نظر یافت نشد: ${req.path}` });
});

// مدیریت خطاهای پیش‌بینی نشده (500)
app.use((err, req, res, next) => {
    console.error('❌ Server Global Error:', err.stack);
    res.status(500).json({ success: false, error: 'خطای داخلی سرور' });
});

// =======================================
// ۵. استارت سرور
// =======================================
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
    console.log('✅ All Systems Active and Ready');
});

module.exports = app;