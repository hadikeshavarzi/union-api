// =======================================
//  union-api/server.js (نسخه نهایی و کامل)
// =======================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const axios = require('axios');

const { supabaseAdmin } = require('./supabaseAdmin');

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

// Log incoming requests
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
// Auth Middleware (برای استفاده در routes)
// =======================================
function authMiddleware(req, res, next) {
    const auth = req.headers.authorization || '';

    if (!auth.startsWith('Bearer ')) {
        return res.status(401).json({
            success: false,
            error: 'توکن ارسال نشده'
        });
    }

    try {
        const token = auth.slice(7);
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        console.log(`✅ Auth: User ${decoded.id} accessing ${req.path}`);

        req.user = decoded;
        next();
    } catch (err) {
        console.error("❌ JWT Error:", err.message);
        return res.status(401).json({
            success: false,
            error: 'توکن نامعتبر است'
        });
    }
}

// =======================================
// REQUEST OTP
// =======================================
app.post('/api/auth/request-otp', async (req, res) => {
    try {
        const { mobile } = req.body;

        if (!mobile) {
            return res.status(400).json({
                success: false,
                error: 'شماره موبایل الزامی است'
            });
        }

        const { data: member, error: memberError } = await supabaseAdmin
            .from('members')
            .select('*')
            .eq('mobile', mobile)
            .single();

        if (memberError || !member) {
            return res.status(404).json({
                success: false,
                error: 'عضو با این شماره یافت نشد'
            });
        }

        // ساخت OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expires = new Date(Date.now() + 2 * 60000).toISOString();

        // ذخیره در DB
        const { error: updateError } = await supabaseAdmin
            .from('members')
            .update({
                otp_code: otp,
                otp_expires: expires,
                updated_at: new Date().toISOString(),
            })
            .eq('id', member.id);

        if (updateError) {
            console.error("❌ OTP Update Error:", updateError);
            return res.status(500).json({
                success: false,
                error: 'خطا در ذخیره کد'
            });
        }

        console.log(`📨 OTP for ${mobile}: ${otp}`);

        // ارسال پیامک
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
                console.log("✅ SMS sent successfully");
            } catch (e) {
                console.error("⚠️ SMS Error:", e.message);
            }
        }

        return res.json({
            success: true,
            message: "کد ورود ارسال شد"
        });

    } catch (err) {
        console.error("❌ Request OTP Error:", err);
        return res.status(500).json({
            success: false,
            error: 'خطای داخلی سرور'
        });
    }
});

// =======================================
// VERIFY OTP
// =======================================
app.post('/api/auth/verify-otp', async (req, res) => {
    try {
        const { mobile, otp } = req.body;

        if (!mobile || !otp) {
            return res.status(400).json({
                success: false,
                error: 'شماره و کد الزامی است'
            });
        }

        const { data: member, error: memberError } = await supabaseAdmin
            .from('members')
            .select('*')
            .eq('mobile', mobile)
            .eq('otp_code', otp)
            .single();

        if (memberError || !member) {
            return res.status(400).json({
                success: false,
                error: 'کد اشتباه است'
            });
        }

        // بررسی انقضا
        if (new Date() > new Date(member.otp_expires)) {
            return res.status(400).json({
                success: false,
                error: 'کد منقضی شده است'
            });
        }

        // پاک کردن OTP
        await supabaseAdmin
            .from('members')
            .update({
                otp_code: null,
                otp_expires: null
            })
            .eq('id', member.id);

        // ساخت توکن
        const token = signToken(member);

        // حذف فیلدهای حساس
        const safeUser = {
            id: member.id,
            full_name: member.full_name,
            mobile: member.mobile,
            role: member.role,
            member_code: member.member_code,
            category: member.category,
            national_id: member.national_id,
            business_name: member.business_name,
        };

        console.log(`✅ Login successful: ${mobile} (ID: ${member.id})`);

        return res.json({
            success: true,
            token,
            user: safeUser,
            message: "ورود موفق"
        });

    } catch (err) {
        console.error("❌ Verify OTP Error:", err);
        return res.status(500).json({
            success: false,
            error: 'خطای داخلی سرور'
        });
    }
});

// =======================================
// Protected Route - User Info
// =======================================
app.get('/api/me', authMiddleware, async (req, res) => {
    try {
        const { id } = req.user;

        const { data: member, error } = await supabaseAdmin
            .from('members')
            .select('*')
            .eq('id', id)
            .single();

        if (error || !member) {
            return res.status(404).json({
                success: false,
                error: 'کاربر یافت نشد'
            });
        }

        // حذف فیلدهای حساس
        delete member.otp_code;
        delete member.otp_expires;

        return res.json({
            success: true,
            user: member
        });

    } catch (err) {
        console.error("❌ Get User Error:", err);
        return res.status(500).json({
            success: false,
            error: 'خطای داخلی سرور'
        });
    }
});

// =======================================
// Routes mounting
// =======================================

app.use("/api/product-units", require("./api/productUnits"));
app.use("/api/product-categories", require("./api/productCategories"));
app.use("/api/media", require("./api/media"));
app.use("/api/products", require("./api/products"));
app.use("/api/customers", require("./api/customers"));
app.use("/api/document-types", require("./api/documentTypes"));
app.use("/api/receipts", require("./api/receipts"));
app.use("/api/receiptItems", require("./api/receiptItems"));
app.use("/api/inventorytransactions", require("./api/inventoryTransactions"));
app.use("/api/inventorystock", require("./api/inventoryStock"));
app.use("/api/clearances", require("./api/clearances"));
app.use("/api/clearance-items", require("./api/clearanceItems"));

// =======================================
// Health Check
// =======================================
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        jwt_secret: !!process.env.JWT_SECRET,
        supabase: !!process.env.SUPABASE_URL,
        sms: !!process.env.MELIPAYAMAK_USERNAME,
        endpoints: [
            'auth/request-otp',
            'auth/verify-otp',
            'me',
            'product-units',
            'product-categories',
            'media',
            'products',
            'customers',
            'document-types',
            'receipts',
            'receiptItems',
            'inventorytransactions',
            'inventorystock',
            'clearances',
            'clearance-items'
        ]
    });
});

// =======================================
// 404 Handler
// =======================================
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Not Found',
        path: req.path,
        method: req.method
    });
});

// =======================================
// Error Handler
// =======================================
app.use((err, req, res, next) => {
    console.error('❌ Server Error:', err);
    res.status(500).json({
        success: false,
        error: 'خطای داخلی سرور',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// =======================================
// Start Server
// =======================================
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`🚀 Backend running on port ${PORT}`);
    console.log(`📍 Health: http://localhost:${PORT}/api/health`);
    console.log(`🔐 JWT: ${process.env.JWT_SECRET ? '✅' : '❌'}`);
    console.log(`📧 SMS: ${process.env.MELIPAYAMAK_USERNAME ? '✅' : '❌'}`);
});