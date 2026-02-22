// =======================================
//  union-api/server.js (FINAL FIX)
// =======================================

require('dotenv').config();

const express = require('express');
const cors = require('cors');

// ✅ اتصال به دیتابیس
const { pool } = require("./supabaseAdmin");

const app = express();

// =======================================
// تنظیمات اولیه
// =======================================
app.set('trust proxy', 1);

// تست دیتابیس
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
    origin: true,
    credentials: true,
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/uploads', express.static(require('path').join(__dirname, 'uploads')));

// Activity Logger Middleware (باید قبل از روت‌ها باشد)
const activityLogger = require('./api/middleware/activityLogger');
app.use(activityLogger);

// =======================================
// تابع کمکی
// =======================================
const mountRoute = (path, routerPath) => {
    try {
        const routeHandler = typeof routerPath === 'string' ? require(routerPath) : routerPath;
        if (typeof routeHandler === 'function' || (routeHandler && typeof routeHandler.use === 'function')) {
            app.use(path, routeHandler);
            console.log(`✔️ Route mounted: ${path}`);
        } else {
            console.error(`⚠️ WARNING: Route at ${path} is missing module.exports!`);
        }
    } catch (err) {
        console.error(`❌ ERROR loading route ${path}:`, err.message);
    }
};

// =======================================
// Routes
// =======================================

// --- Auth ---
mountRoute("/api/auth", "./api/routes/auth");
mountRoute("/api/auth/customer-request-otp", "./api/auth/customer-request-otp");
mountRoute("/api/auth/customer-verify-otp", "./api/auth/customer-verify-otp");

// --- Warehouse & Products ---
mountRoute('/api/warehouse', './api/warehouse');
mountRoute('/api/product-units', './api/productUnits');
mountRoute('/api/product-categories', './api/productCategories');
mountRoute('/api/media', './api/media');
mountRoute('/api/products', './api/products');
mountRoute('/api/customers', './api/customers');
mountRoute('/api/document-types', './api/documentTypes');

// ✅ Receipts - Direct mount
const receiptsRouter = require('./api/receipts');
app.use('/api/receipts', receiptsRouter);
console.log('✔️ Route mounted: /api/receipts (direct)');

mountRoute('/api/receipt-items', './api/receiptItems');
mountRoute('/api/inventory-transactions', './api/inventoryTransactions');
mountRoute('/api/inventory-stock', './api/inventoryStock');
mountRoute('/api/clearances', './api/clearances');
mountRoute('/api/clearance-items', './api/clearanceItems');

// --- Logistics ---
mountRoute('/api/loadings', './api/loadings');
mountRoute('/api/exits', './api/exits');

// --- Accounting ---
mountRoute('/api/accounting/reports', './api/accounting/reports');
mountRoute('/api/accounting', './api/accounting/index');
mountRoute('/api/accounting-groups', './api/accounting/groups');
mountRoute('/api/accounting-gl', './api/accounting/gl');
mountRoute('/api/accounting-moein', './api/accounting/moein');
mountRoute('/api/accounting-tafsili', './api/accounting/tafsili');

// --- Treasury ---
mountRoute('/api/base-banks', './api/baseBanks');
mountRoute('/api/treasury-banks', './api/treasury/banks');
mountRoute('/api/treasury-cashes', './api/treasury/cashes');
mountRoute('/api/treasury-pos', './api/treasury/pos');
mountRoute('/api/treasury-checkbooks', './api/treasury/checkbooks');
mountRoute('/api/treasury-checks', './api/treasury/checks');
mountRoute('/api/treasury', './api/treasury/operations');
mountRoute('/api/treasury', './api/treasury/index');

// --- Rentals ---
mountRoute('/api/rentals', './api/rentals');

// --- Calendar ---
mountRoute('/api/calendar', './api/calendar');

// --- Settings ---
mountRoute('/api/settings', './api/settings');

// --- Activity Logs ---
mountRoute('/api/activity-logs', './api/activityLog');

// --- Tickets & Support ---
mountRoute('/api/tickets', './api/tickets');

// --- Reports & Members ---
mountRoute('/api/reports', './api/reports/index');
mountRoute("/api/members", "./api/members");

// --- Public (QR Code - No Auth) ---
mountRoute('/api/public', './api/public');

// --- Permissions ---
mountRoute('/api/permissions', './api/permissions.routes');

// --- SMS Panel (Super Admin Only) ---
mountRoute('/api/sms-panel', './api/smsPanel');

// --- Opening Balance ---
mountRoute('/api/opening-balance', './api/openingBalance');

// =======================================
// Final handlers
// =======================================

// Health check
app.get('/api/health', (req, res) => res.json({ 
    status: 'ok', 
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
}));

// 404 handler
app.use((req, res) => {
    console.log(`⚠️ 404: ${req.method} ${req.path}`);
    res.status(404).json({ 
        success: false, 
        error: `مسیر مورد نظر یافت نشد: ${req.path}` 
    });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('❌ Global Error:', err.stack);
    res.status(500).json({ 
        success: false, 
        error: 'خطای داخلی سرور'
    });
});

// =======================================
// Start server
// =======================================
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log('✅ All Systems Ready');

    try {
        const { startScheduler } = require("./api/utils/scheduler");
        startScheduler();
    } catch (e) {
        console.error("Scheduler init error:", e.message);
    }
});

module.exports = app;