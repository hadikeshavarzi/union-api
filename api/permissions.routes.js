const express = require("express");
const router = express.Router();
const { pool } = require("../supabaseAdmin"); 
const db = pool; 
const authMiddleware = require("./middleware/auth");

router.use(authMiddleware);

const SUPER_ADMIN_ROLE_CODES = new Set([
  "super_admin",
  "super-admin",
  "superadmin",
  "owner",
  "admin",
  "root",
  "system_admin",
]);

const normalizeRoleCode = (value) => String(value || "").toLowerCase().trim();

const resolveRoleContext = async (userId) => {
  const roleResult = await db.query(
    `
      SELECT ur.role_id, r.code
      FROM user_roles ur
      JOIN roles r ON ur.role_id = r.id
      WHERE (ur.user_id = $1 OR ur.member_id = $1)
        AND ur.is_active = true
        AND COALESCE(r.is_active, true) = true
    `,
    [userId]
  );

  const memberResult = await db.query(
    `SELECT role FROM members WHERE id = $1 LIMIT 1`,
    [userId]
  );

  const roleIds = [...new Set(roleResult.rows.map((row) => row.role_id).filter(Boolean))];
  const roleCodes = roleResult.rows
    .map((row) => normalizeRoleCode(row.code))
    .filter(Boolean);
  const memberRole = normalizeRoleCode(memberResult.rows[0]?.role);

  const isSuperAdmin =
    roleCodes.some((code) => SUPER_ADMIN_ROLE_CODES.has(code)) ||
    SUPER_ADMIN_ROLE_CODES.has(memberRole);

  return { roleIds, roleCodes, memberRole, isSuperAdmin };
};

// ==================================================================
// 1. دریافت پرمیشن‌های کاربر جاری (برای چک کردن دکمه‌ها و دسترسی کامپوننت‌ها)
// ==================================================================
router.get('/my-permissions', async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.id) return res.status(401).json({ success: false, message: 'نشست نامعتبر' });

    const { roleIds, isSuperAdmin } = await resolveRoleContext(user.id);

    // تبدیل آرایه به آبجکت برای جستجوی سریع در فرانت
    const permissionsMap = {};

    if (roleIds.length > 0) {
      const permQuery = `
        SELECT p.code
        FROM role_permissions rp
        JOIN permissions p ON rp.permission_id = p.id
        WHERE rp.role_id = ANY($1::uuid[])
      `;
      const permResult = await db.query(permQuery, [roleIds]);
      permResult.rows.forEach((p) => {
        if (p.code) permissionsMap[p.code.toLowerCase().trim()] = true;
      });
    }

    if (isSuperAdmin) {
      permissionsMap["*"] = true;
    }

    res.json({ success: true, permissions: permissionsMap });
  } catch (error) {
    console.error('❌ Error in /my-permissions:', error);
    res.status(500).json({ success: false, message: 'خطای پایگاه داده' });
  }
});

// ==================================================================
// 2. مدیریت فرم‌های UI (منوهای داینامیک)
// ==================================================================

// دریافت کل فرم‌ها برای صفحه مدیریت (بدون فیلتر)
router.get('/ui-forms/all', async (req, res) => {
  try {
    const result = await db.query(`SELECT * FROM ui_forms ORDER BY menu_order ASC`);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// دریافت فرم‌های مجاز برای کاربر جاری (سایدبار هوشمند)
router.get('/my-forms', async (req, res) => {
  try {
    const userId = req.user.id;
    const { isSuperAdmin } = await resolveRoleContext(userId);

    if (isSuperAdmin) {
      const result = await db.query(
        `
          SELECT *
          FROM (
            SELECT DISTINCT ON (LOWER(BTRIM(f.path))) f.*
            FROM ui_forms f
            WHERE f.is_active = true
              AND f.path IS NOT NULL
              AND BTRIM(f.path) <> ''
            ORDER BY
              LOWER(BTRIM(f.path)),
              COALESCE(f.menu_order, 0) ASC,
              f.updated_at DESC NULLS LAST,
              f.created_at DESC NULLS LAST,
              f.id DESC
          ) dedup
          ORDER BY COALESCE(menu_order, 0) ASC, created_at ASC NULLS LAST
        `
      );
      return res.json({ success: true, data: result.rows || [] });
    }

    const query = `
      SELECT *
      FROM (
        SELECT DISTINCT ON (LOWER(BTRIM(f.path))) f.*
        FROM ui_forms f
        WHERE f.is_active = true
          AND f.path IS NOT NULL
          AND BTRIM(f.path) <> ''
          AND (
            COALESCE(BTRIM(f.permission_code), '') = ''
            OR EXISTS (
              SELECT 1
              FROM permissions p
              JOIN role_permissions rp ON rp.permission_id = p.id
              JOIN user_roles ur ON ur.role_id = rp.role_id
              JOIN roles r ON r.id = ur.role_id
              WHERE LOWER(p.code) = LOWER(f.permission_code)
                AND (ur.member_id = $1 OR ur.user_id = $1)
                AND ur.is_active = true
                AND COALESCE(r.is_active, true) = true
            )
          )
        ORDER BY
          LOWER(BTRIM(f.path)),
          COALESCE(f.menu_order, 0) ASC,
          f.updated_at DESC NULLS LAST,
          f.created_at DESC NULLS LAST,
          f.id DESC
      ) dedup
      ORDER BY COALESCE(menu_order, 0) ASC, created_at ASC NULLS LAST
    `;

    const result = await db.query(query, [userId]);
    res.json({ success: true, data: result.rows || [] });
  } catch (error) {
    console.error('❌ Error fetching filtered forms:', error);
    res.status(500).json({ success: false, message: 'خطا در واکشی منوها' });
  }
});

// ایجاد یا ویرایش فرم (شامل فیلد permission_code)
router.post('/ui-forms', async (req, res) => {
  try {
    // ✅ دریافت permission_code از بادی درخواست
    const { id, title, path, icon, module, menu_order, is_active, permission_code } = req.body;
    
    // تبدیل رشته خالی به null برای دیتابیس
    const permCodeValue = permission_code && permission_code.trim() !== '' ? permission_code : null;

    if (id) {
      // ویرایش فرم موجود
      await db.query(
        `UPDATE ui_forms SET 
          title=$1, path=$2, icon=$3, module=$4, menu_order=$5, is_active=$6, permission_code=$7, updated_at=NOW() 
         WHERE id=$8`,
        [title, path, icon, module, menu_order || 0, is_active, permCodeValue, id]
      );
      return res.json({ success: true, message: 'بروزرسانی انجام شد' });
    } else {
      // ایجاد فرم جدید
      const result = await db.query(
        `INSERT INTO ui_forms (title, path, icon, module, menu_order, is_active, permission_code) 
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [title, path, icon, module, menu_order || 0, is_active, permCodeValue]
      );
      return res.json({ success: true, data: result.rows[0], message: 'فرم جدید ثبت شد' });
    }
  } catch (error) {
    console.error('❌ Database Save Error:', error);
    res.status(500).json({ success: false, message: 'خطا در دیتابیس: ' + error.message });
  }
});

// ==================================================================
// 3. مدیریت نقش‌ها (Roles)
// ==================================================================
// ==================================================================
// 3. مدیریت نقش‌ها (Roles) - CRUD کامل
// ==================================================================

// دریافت لیست نقش‌ها
router.get('/roles', async (req, res) => {
  try {
    const result = await db.query(`SELECT * FROM roles ORDER BY created_at DESC`);
    
    // افزودن تعداد کاربران هر نقش (اختیاری ولی مفید برای نمایش در جدول)
    for (let role of result.rows) {
        const count = await db.query(`SELECT COUNT(*) FROM user_roles WHERE role_id = $1`, [role.id]);
        role.user_count = parseInt(count.rows[0].count);
    }
    
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: 'خطا در دریافت نقش‌ها' });
  }
});

// ایجاد نقش جدید (POST)
// ایجاد نقش جدید (POST) - نسخه عیب‌یابی
// ایجاد نقش جدید (POST) - نسخه اصلاح شده با member_id
router.post('/roles', async (req, res) => {
  try {
    const { code, title, description, is_active } = req.body;
    
    // ۱. دریافت آی‌دی کاربری که دارد نقش را می‌سازد
    // اگر member_id در توکن نیست، از user_id استفاده می‌کنیم
    const ownerId = req.user.member_id || req.user.id;

    if (!ownerId) {
      return res.status(400).json({ success: false, message: 'شناسه کاربر (Member ID) یافت نشد.' });
    }

    // ۲. بررسی تکراری نبودن کد نقش
    const check = await db.query('SELECT id FROM roles WHERE code = $1', [code]);
    if (check.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'این کد نقش قبلا ثبت شده است' });
    }

    // ۳. اینسرت کردن با member_id
    const result = await db.query(
      `INSERT INTO roles (member_id, code, title, description, is_active, is_system) 
       VALUES ($1, $2, $3, $4, $5, false) 
       RETURNING *`,
      [ownerId, code, title, description, is_active]
    );
    
    res.json({ success: true, data: result.rows[0], message: 'نقش جدید با موفقیت ایجاد شد' });

  } catch (error) {
    console.error('❌ Error creating role:', error);
    res.status(500).json({ 
      success: false, 
      message: 'خطای دیتابیس: ' + (error.message) 
    });
  }
});

// ویرایش نقش (PUT)
router.put('/roles/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, is_active } = req.body;

    await db.query(
      `UPDATE roles SET title=$1, description=$2, is_active=$3, updated_at=NOW() WHERE id=$4`,
      [title, description, is_active, id]
    );

    res.json({ success: true, message: 'نقش با موفقیت ویرایش شد' });
  } catch (error) {
    console.error('Error updating role:', error);
    res.status(500).json({ success: false, message: 'خطا در ویرایش نقش' });
  }
});

// حذف نقش (DELETE)
router.delete('/roles/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // جلوگیری از حذف نقش‌هایی که کاربر دارند
    const userCheck = await db.query('SELECT COUNT(*) FROM user_roles WHERE role_id = $1', [id]);
    if (parseInt(userCheck.rows[0].count) > 0) {
      return res.status(400).json({ success: false, message: 'این نقش به کاربرانی اختصاص داده شده و قابل حذف نیست.' });
    }

    await db.query('DELETE FROM roles WHERE id=$1', [id]);
    res.json({ success: true, message: 'نقش با موفقیت حذف شد' });
  } catch (error) {
    console.error('Error deleting role:', error);
    res.status(500).json({ success: false, message: 'خطا در حذف نقش' });
  }
});

// ==================================================================
// 4. مدیریت کل پرمیشن‌های سیستم
// ==================================================================
router.get('/permissions', async (req, res) => {
  try {
    const result = await db.query(`SELECT * FROM permissions ORDER BY module, action`);
    const grouped = result.rows.reduce((acc, perm) => {
      if (!acc[perm.module]) acc[perm.module] = [];
      acc[perm.module].push(perm);
      return acc;
    }, {});
    res.json({ success: true, data: result.rows, grouped });
  } catch (error) {
    res.status(500).json({ success: false, message: 'خطا در دریافت لیست دسترسی‌ها' });
  }
});

// ==================================================================
// 5. تخصیص نقش به کاربران (User Role Assignment)
// ==================================================================

router.get('/users/:userId/roles', async (req, res) => {
  try {
    const { userId } = req.params;
    const query = `
      SELECT ur.*, r.title as role_title, r.code as role_code
      FROM user_roles ur
      JOIN roles r ON ur.role_id = r.id
      WHERE (ur.member_id = $1 OR ur.user_id = $1)
    `;
    const result = await db.query(query, [userId]);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: 'خطا در دریافت نقش‌های کاربر' });
  }
});

router.post('/users/:userId/roles', async (req, res) => {
  try {
    const { userId } = req.params;
    const { role_id, valid_from, valid_to } = req.body;
    const query = `
      INSERT INTO user_roles (member_id, user_id, role_id, valid_from, valid_to, is_active)
      VALUES ($1, $1, $2, $3, $4, true)
      RETURNING *
    `;
    const result = await db.query(query, [userId, role_id, valid_from || new Date(), valid_to || null]);
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, message: 'خطا در اختصاص نقش' });
  }
});

router.delete('/users/:userId/roles/:roleId', async (req, res) => {
  try {
    const { userId, roleId } = req.params;
    await db.query(`DELETE FROM user_roles WHERE (member_id = $1 OR user_id = $1) AND role_id = $2`, [userId, roleId]);
    res.json({ success: true, message: 'نقش حذف شد' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'خطا در حذف نقش' });
  }
});

// مدیریت دسترسی‌های یک نقش
router.get('/roles/:roleId/permissions', async (req, res) => {
  try {
    const result = await db.query(`SELECT permission_id FROM role_permissions WHERE role_id = $1`, [req.params.roleId]);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: 'خطا در دریافت دسترسی‌های نقش' });
  }
});

router.put('/roles/:roleId/permissions', async (req, res) => {
  const client = await db.connect();
  try {
    const { roleId } = req.params;
    const { permissions } = req.body;
    await client.query('BEGIN');
    await client.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
    if (permissions && permissions.length > 0) {
      for (const p of permissions) {
        await client.query('INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)', [roleId, p.permission_id]);
      }
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, message: 'خطا در بروزرسانی دسترسی‌ها' });
  } finally {
    client.release();
  }
});

module.exports = router;