// =======================================
//  union-api/server.js (نسخه کامل و نهایی)
// =======================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { supabaseAdmin } = require('./supabaseAdmin');

// --- Import Routes ---
const loadingRoutes = require('./api/loadings');
const exitRoutes = require('./api/exits');
// نکته: فایل operations.js حاوی روت‌های عملیاتی خزانه مثل ثبت سند خروج است
const treasuryOpsRoutes = require('./api/treasury/operations');

const app = express();

// =======================================
// Middleware
// =======================================
app.use(cors({
    origin: [
        'http://localhost:5173',
        'http://localhost:3000',
        'https://portal.anbardaranrey.ir',
        'http://portal.anbardaranrey.ir'
    ],
    credentials: true,
}));

app.use(express.json());

// Log incoming requests (برای دیباگ)
app.use((req, res, next) => {
    console.log(`📥 ${req.method} ${req.path}`);
    next();
});

// =======================================
// JWT Helper
// =======================================
function signToken(member) {
    return jwt.sign(
        {
            id: member.id,
            role: member.role || 'union_member',
            mobile: member.mobile,
        },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
    );
}

// =======================================
// Auth Middleware
// =======================================
function authMiddleware(req, res, next) {
    const auth = req.headers.authorization || '';

    if (!auth.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'توکن ارسال نشده' });
    }

    try {
        const token = auth.slice(7);
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        // console.log(`✅ Auth: User ${decoded.id} accessing ${req.path}`);
        req.user = decoded;
        next();
    } catch (err) {
        console.error("❌ JWT Error:", err.message);
        return res.status(401).json({ success: false, error: 'توکن نامعتبر است' });
    }
}

// =======================================
// AUTH Routes (OTP)
// =======================================
app.post('/api/auth/request-otp', async (req, res) => {
    try {
        const { mobile } = req.body;
        if (!mobile) return res.status(400).json({ success: false, error: 'شماره موبایل الزامی است' });

        const { data: member, error: memberError } = await supabaseAdmin
            .from('members').select('*').eq('mobile', mobile).single();

        if (memberError || !member) return res.status(404).json({ success: false, error: 'عضو با این شماره یافت نشد' });

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expires = new Date(Date.now() + 2 * 60000).toISOString();

        await supabaseAdmin.from('members').update({ otp_code: otp, otp_expires: expires, updated_at: new Date().toISOString() }).eq('id', member.id);

        console.log(`📨 OTP for ${mobile}: ${otp}`);

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
            } catch (e) { console.error("⚠️ SMS Error:", e.message); }
        }

        return res.json({ success: true, message: "کد ورود ارسال شد" });
    } catch (err) {
        console.error("❌ Request OTP Error:", err);
        return res.status(500).json({ success: false, error: 'خطای داخلی سرور' });
    }
});

app.post('/api/auth/verify-otp', async (req, res) => {
    try {
        const { mobile, otp } = req.body;
        if (!mobile || !otp) return res.status(400).json({ success: false, error: 'شماره و کد الزامی است' });

        const { data: member, error: memberError } = await supabaseAdmin
            .from('members').select('*').eq('mobile', mobile).eq('otp_code', otp).single();

        if (memberError || !member) return res.status(400).json({ success: false, error: 'کد اشتباه است' });
        if (new Date() > new Date(member.otp_expires)) return res.status(400).json({ success: false, error: 'کد منقضی شده است' });

        await supabaseAdmin.from('members').update({ otp_code: null, otp_expires: null }).eq('id', member.id);

        const token = signToken(member);
        const safeUser = { id: member.id, full_name: member.full_name, mobile: member.mobile, role: member.role, member_code: member.member_code, category: member.category, national_id: member.national_id, business_name: member.business_name };

        return res.json({ success: true, token, user: safeUser, message: "ورود موفق" });
    } catch (err) {
        console.error("❌ Verify OTP Error:", err);
        return res.status(500).json({ success: false, error: 'خطای داخلی سرور' });
    }
});


// روت دریافت اطلاعات پروفایل (Get Current User)
app.get('/api/me', authMiddleware, async (req, res) => {
    try {
        // آی‌دی کاربر را از توکن (که میدلور دیکود کرده) می‌گیریم
        const { id } = req.user;

        // ✅ خواندن مستقیم و تازه از جدول members
        const { data: member, error } = await supabaseAdmin
            .from('members')
            .select('*') // همه فیلدها شامل avatar_url, full_name, role و...
            .eq('id', id)
            .single();

        if (error || !member) {
            return res.status(404).json({ success: false, error: 'کاربر یافت نشد' });
        }

        // حذف اطلاعات حساس قبل از ارسال
        delete member.otp_code;
        delete member.otp_expires;
        delete member.password; // اگر دارید

        return res.json({
            success: true,
            user: member // کل اطلاعات ممبر را می‌فرستیم
        });

    } catch (err) {
        console.error("❌ API Me Error:", err);
        return res.status(500).json({ success: false, error: 'خطای سرور' });
    }
});
// =======================================
// Routes Mounting
// =======================================

// --- Warehouse & Inventory ---
app.use("/api/product-units", require("./api/productUnits"));
app.use("/api/product-categories", require("./api/productCategories"));
app.use("/api/media", require("./api/media"));
app.use("/api/products", require("./api/products"));
app.use("/api/customers", require("./api/customers"));
app.use("/api/document-types", require("./api/documentTypes"));
app.use("/api/receipts", require("./api/receipts"));
app.use("/api/receipt-items", require("./api/receiptItems"));
app.use("/api/inventory-transactions", require("./api/inventoryTransactions"));
app.use("/api/inventory-stock", require("./api/inventoryStock"));
app.use("/api/clearances", require("./api/clearances"));
app.use("/api/clearance-items", require("./api/clearanceItems"));

// --- Loading & Exit (Multi-tenant) ---
app.use('/api/loadings', loadingRoutes);
app.use('/api/exits', exitRoutes);

// --- Accounting ---
app.use("/api/accounting-groups", require("./api/accounting/groups"));
app.use("/api/accounting-gl", require("./api/accounting/gl"));
app.use("/api/accounting-moein", require("./api/accounting/moein"));
app.use("/api/accounting-tafsili", require("./api/accounting/tafsili"));
app.use("/api/accounting", require("./api/accounting/balance"));

// --- Treasury ---
app.use("/api/base-banks", require("./api/baseBanks"));
app.use("/api/treasury-banks", require("./api/treasury/banks"));
app.use("/api/treasury-cashes", require("./api/treasury/cashes"));
app.use("/api/treasury-pos", require("./api/treasury/pos"));
app.use("/api/treasury-checkbooks", require("./api/treasury/checkbooks"));
app.use("/api/treasury-checks", require("./api/treasury/checks"));
// ✅ اصلاح شده: helpers نباید mount شود، اما operations (ثبت سند خروج) باید mount شود
app.use('/api/treasury', treasuryOpsRoutes);

// --- Financial Documents ---
app.use("/api/financial-documents", require("./api/financial/documents"));

// --- Reports ---
app.use("/api/reports", require("./api/reports/index"));

// =======================================
// Health Check
// =======================================
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        endpoints: {
            auth: ['auth/request-otp', 'auth/verify-otp', 'me'],
            warehouse: ['receipts', 'inventory-stock', 'clearances'],
            logistics: ['loadings', 'exits'],
            treasury: ['treasury-banks', 'treasury/register-exit-doc']
        }
    });
});

// =======================================
// Error Handlers
// =======================================
app.use((req, res) => {
    console.log(`❌ 404: ${req.method} ${req.path}`);
    res.status(404).json({ success: false, error: 'Not Found', path: req.path });
});

app.use((err, req, res, next) => {
    console.error('❌ Server Error:', err);
    res.status(500).json({ success: false, error: 'خطای داخلی سرور' });
});

// =======================================
// Start Server
// =======================================
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`✅ Loaded Modules: Warehouse, Accounting, Treasury, Logistics`);
});

module.exports = app;