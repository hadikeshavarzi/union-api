const jwt = require("jsonwebtoken");
const { pool } = require("../../supabaseAdmin");

function getBearerToken(req) {
  const authHeader = req.headers['authorization'] || req.headers['x-access-token'];
  if (!authHeader) return null;
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7, authHeader.length).trim();
  }
  return authHeader.trim();
}

async function authMiddleware(req, res, next) {
  try {
    const token = getBearerToken(req);
    
    if (!token) {
      return res.status(401).json({ 
        success: false, 
        error: "توکن ارسال نشده است", 
        code: "AUTH_NO_TOKEN" 
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ 
        success: false, 
        error: "توکن نامعتبر است", 
        code: "AUTH_TOKEN_INVALID" 
      });
    }

    const userId = decoded.sub || decoded.id || decoded.user_id;

    if (!userId) {
      return res.status(401).json({ success: false, error: "شناسه کاربر نامعتبر است" });
    }

    // ۱. دریافت اطلاعات عضو (Member)
    const memberQuery = `
      SELECT id, role, mobile, owner_id, full_name, member_code
      FROM members
      WHERE id = $1
      LIMIT 1
    `;
    
    const { rows: memberRows } = await pool.query(memberQuery, [userId]);
    const member = memberRows[0];

    const memberId = member ? member.id : userId;

    // ۲. دریافت پرمیشن‌ها (RBAC)
    let permissionsList = [];
    try {
        // ✅ اصلاح شده: تغییر ur.user_id به ur.member_id برای جلوگیری از ارور
        const permQuery = `
          SELECT p.module, p.action
          FROM user_roles ur
          JOIN role_permissions rp ON ur.role_id = rp.role_id
          JOIN permissions p ON rp.permission_id = p.id
          WHERE (ur.member_id = $1 OR ur.user_id = $1) AND ur.is_active = true
        `;
        const { rows: permRows } = await pool.query(permQuery, [userId]);
        
        permissionsList = permRows.map(row => `${row.module.toLowerCase()}.${row.action.toLowerCase()}`);
        permissionsList = [...new Set(permissionsList)];
    } catch (dbErr) {
        console.error("⚠️ [Auth] Error fetching permissions:", dbErr.message);
        // در صورت خطای دیتابیس، لیست را خالی نمی‌گذاریم تا جلوی لاگین گرفته نشود
    }

    // پرمیشن‌های پیش‌فرض برای کسانی که نقشی ندارند
    if (permissionsList.length === 0) {
        permissionsList = ["dashboard.view", "client.portal"];
    }

    // ۳. تشکیل آبجکت کاربر
    req.user = {
      id: userId,
      member_id: memberId,
      full_name: member ? (member.full_name || member.company_name) : "کاربر",
      role: member ? member.role : "user",
      permissions: permissionsList,
      token: token
    };

    req.hasPermission = (perm) => {
        if (!perm) return true;
        return req.user.permissions.includes(perm.toLowerCase());
    };

    return next();

  } catch (err) {
    console.error("🔥 [Auth Middleware Fatal Error]:", err.stack);
    return res.status(500).json({ success: false, error: "خطای داخلی سرور در بخش احراز هویت" });
  }
}

module.exports = authMiddleware;