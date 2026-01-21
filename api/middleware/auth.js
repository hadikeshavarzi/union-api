// api/middleware/auth.js
const jwt = require('jsonwebtoken');
const { supabaseAdmin } = require('../../supabaseAdmin');

const authMiddleware = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization || req.headers.Authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, error: 'توکن ارسال نشده است' });
        }

        const token = authHeader.split(' ')[1];

        if (!process.env.JWT_SECRET) {
            throw new Error("JWT_SECRET در فایل env تنظیم نشده است");
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        let tokenPhone = decoded.phone || decoded.user_metadata?.phone;

        if (!tokenPhone) {
            console.error("❌ Token has no phone number:", decoded);
            throw new Error("شماره موبایل در توکن یافت نشد");
        }

        // نرمال‌سازی شماره
        let searchPhone = tokenPhone;
        if (tokenPhone.startsWith('+98')) {
            searchPhone = '0' + tokenPhone.substring(3);
        } else if (tokenPhone.startsWith('98')) {
            searchPhone = '0' + tokenPhone.substring(2);
        }

        // جستجوی member
        const { data: member, error } = await supabaseAdmin
            .from('members')
            .select('id, role, full_name, mobile, email, member_code, owner_id, permissions, member_status')
            .or(`mobile.eq.${searchPhone},mobile.eq.${tokenPhone},mobile.eq.+${tokenPhone.replace('+','')}`)
            .maybeSingle();

        if (error || !member) {
            console.error(`❌ User not found in DB. Token Phone: ${tokenPhone}, Search: ${searchPhone}`);
            return res.status(403).json({
                success: false,
                error: 'اطلاعات کاربری شما در سیستم یافت نشد.'
            });
        }

        // ✅ چک وضعیت عضویت
        if (member.member_status !== 'active') {
            return res.status(403).json({
                success: false,
                error: 'حساب کاربری شما غیرفعال است'
            });
        }

        // تزریق اطلاعات کامل
        req.user = member;
        req.user.auth_uuid = decoded.sub;

        next();

    } catch (err) {
        console.error("💥 Auth Error:", err.message);
        return res.status(401).json({
            success: false,
            error: 'نشست کاربری نامعتبر یا منقضی شده است'
        });
    }
};

module.exports = authMiddleware;