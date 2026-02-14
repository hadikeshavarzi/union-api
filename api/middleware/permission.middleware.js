const express = require("express");
const router = express.Router();
const { pool } = require("../supabaseAdmin");
const authMiddleware = require("./middleware/auth");

const db = pool;

// ---------------------------------------------
// Optional permission middleware adapter
// supports both exports:
// 1) module.exports = requirePermission
// 2) module.exports = { requirePermission }
// ---------------------------------------------
let requirePermission = () => (_req, _res, next) => next();
try {
  const permissionModule = require("./middleware/permission.middleware");
  const fn =
    typeof permissionModule === "function"
      ? permissionModule
      : typeof permissionModule?.requirePermission === "function"
      ? permissionModule.requirePermission
      : null;

  if (fn) {
    requirePermission = (...codes) => fn(...codes);
  }
} catch (e) {
  // اگر فایل وجود نداشت یا export متفاوت بود، route ها فقط auth می‌خورند
  console.warn("⚠️ permission.middleware not loaded. Auth-only mode.");
}

router.use(authMiddleware);

// ---------------------------------------------
// Helpers
// ---------------------------------------------
const normalizeCode = (value) => String(value || "").toLowerCase().trim();

const normalizeNullableText = (value) => {
  const text = String(value ?? "").trim();
  return text === "" ? null : text;
};

const parseBoolean = (value, fallback = true) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
  }
  return fallback;
};

const parseNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const getActorId = (req) => req.user?.member_id || req.user?.id || null;

// ==================================================================
// 1) دریافت پرمیشن‌های کاربر جاری
// ==================================================================
router.get("/my-permissions", async (req, res) => {
  try {
    const userId = getActorId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: "نشست نامعتبر" });
    }

    const query = `
      SELECT DISTINCT LOWER(TRIM(p.code)) AS code
      FROM user_roles ur
      JOIN role_permissions rp ON rp.role_id = ur.role_id
      JOIN permissions p ON p.id = rp.permission_id
      WHERE
        ur.is_active = true
        AND (ur.user_id = $1 OR ur.member_id = $1)
        AND (ur.valid_from IS NULL OR ur.valid_from <= NOW())
        AND (ur.valid_to IS NULL OR ur.valid_to >= NOW())
    `;

    const result = await db.query(query, [userId]);

    const permissionsMap = {};
    result.rows.forEach((row) => {
      if (row.code) permissionsMap[row.code] = true;
    });

    return res.json({ success: true, permissions: permissionsMap });
  } catch (error) {
    console.error("❌ Error in /my-permissions:", error);
    return res.status(500).json({ success: false, message: "خطای پایگاه داده" });
  }
});

// ==================================================================
// 2) مدیریت فرم‌های UI (منوهای داینامیک)
// ==================================================================

// دریافت کل فرم‌ها برای صفحه مدیریت
router.get(
  "/ui-forms/all",
  requirePermission("settings.ui-forms.view"),
  async (_req, res) => {
    try {
      const result = await db.query(`
        SELECT *
        FROM ui_forms
        ORDER BY COALESCE(menu_order, 0) ASC, title ASC
      `);
      return res.json({ success: true, data: result.rows });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
);

// دریافت فرم‌های مجاز برای کاربر جاری (سایدبار هوشمند)
router.get("/my-forms", async (req, res) => {
  try {
    const userId = getActorId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: "نشست نامعتبر" });
    }

    const query = `
      SELECT f.*
      FROM ui_forms f
      WHERE
        f.is_active = true
        AND (
          NULLIF(TRIM(f.permission_code), '') IS NULL
          OR EXISTS (
            SELECT 1
            FROM permissions p
            JOIN role_permissions rp ON rp.permission_id = p.id
            JOIN user_roles ur ON ur.role_id = rp.role_id
            WHERE
              LOWER(TRIM(p.code)) = LOWER(TRIM(f.permission_code))
              AND ur.is_active = true
              AND (ur.user_id = $1 OR ur.member_id = $1)
              AND (ur.valid_from IS NULL OR ur.valid_from <= NOW())
              AND (ur.valid_to IS NULL OR ur.valid_to >= NOW())
          )
        )
      ORDER BY COALESCE(f.menu_order, 0) ASC, f.title ASC
    `;

    const result = await db.query(query, [userId]);
    return res.json({ success: true, data: result.rows || [] });
  } catch (error) {
    console.error("❌ Error fetching /my-forms:", error);
    return res.status(500).json({ success: false, message: "خطا در واکشی منوها" });
  }
});

// ایجاد یا ویرایش فرم
router.post(
  "/ui-forms",
  requirePermission("settings.ui-forms.create", "settings.ui-forms.edit"),
  async (req, res) => {
    try {
      const {
        id,
        title,
        path,
        icon,
        module,
        menu_order,
        is_active,
        permission_code,
      } = req.body;

      const cleanTitle = String(title || "").trim();
      const cleanPath = String(path || "").trim();
      const cleanIcon = normalizeNullableText(icon);
      const cleanModule = normalizeNullableText(module);
      const cleanPermCode = normalizeNullableText(permission_code);
      const menuOrder = parseNumber(menu_order, 0);
      const isActive = parseBoolean(is_active, true);

      if (!cleanTitle || !cleanPath) {
        return res.status(400).json({
          success: false,
          message: "عنوان و مسیر (Path) الزامی است.",
        });
      }

      // اگر permission_code ارسال شده، باید در جدول permissions وجود داشته باشد
      if (cleanPermCode) {
        const permCheck = await db.query(
          `SELECT 1 FROM permissions WHERE LOWER(TRIM(code)) = LOWER(TRIM($1)) LIMIT 1`,
          [cleanPermCode]
        );
        if (permCheck.rowCount === 0) {
          return res.status(400).json({
            success: false,
            message: "permission_code معتبر نیست.",
          });
        }
      }

      if (id) {
        const updateResult = await db.query(
          `
          UPDATE ui_forms
          SET
            title = $1,
            path = $2,
            icon = $3,
            module = $4,
            menu_order = $5,
            is_active = $6,
            permission_code = $7,
            updated_at = NOW()
          WHERE id = $8
          RETURNING id
          `,
          [cleanTitle, cleanPath, cleanIcon, cleanModule, menuOrder, isActive, cleanPermCode, id]
        );

        if (updateResult.rowCount === 0) {
          return res.status(404).json({ success: false, message: "فرم یافت نشد." });
        }

        return res.json({ success: true, message: "بروزرسانی انجام شد" });
      }

      const insertResult = await db.query(
        `
        INSERT INTO ui_forms (title, path, icon, module, menu_order, is_active, permission_code)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id
        `,
        [cleanTitle, cleanPath, cleanIcon, cleanModule, menuOrder, isActive, cleanPermCode]
      );

      return res.json({
        success: true,
        data: insertResult.rows[0],
        message: "فرم جدید ثبت شد",
      });
    } catch (error) {
      console.error("❌ Database Save Error (/ui-forms):", error);
      return res.status(500).json({
        success: false,
        message: "خطا در دیتابیس: " + error.message,
      });
    }
  }
);

// ==================================================================
// 3) مدیریت نقش‌ها (Roles)
// ==================================================================

// دریافت لیست نقش‌ها (بهینه - بدون N+1)
router.get("/roles", requirePermission("settings.roles.view"), async (_req, res) => {
  try {
    const result = await db.query(`
      SELECT
        r.*,
        COALESCE(uc.user_count, 0)::int AS user_count
      FROM roles r
      LEFT JOIN (
        SELECT role_id, COUNT(*) AS user_count
        FROM user_roles
        WHERE is_active = true
        GROUP BY role_id
      ) uc ON uc.role_id = r.id
      ORDER BY r.created_at DESC
    `);

    return res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error("❌ Error fetching roles:", error);
    return res.status(500).json({ success: false, message: "خطا در دریافت نقش‌ها" });
  }
});

// ایجاد نقش جدید
router.post("/roles", requirePermission("settings.roles.create"), async (req, res) => {
  try {
    const { code, title, description, is_active } = req.body;
    const ownerId = getActorId(req);

    if (!ownerId) {
      return res.status(400).json({
        success: false,
        message: "شناسه کاربر یافت نشد.",
      });
    }

    const cleanCode = String(code || "").trim();
    const cleanTitle = String(title || "").trim();

    if (!cleanCode || !cleanTitle) {
      return res.status(400).json({
        success: false,
        message: "کد نقش و عنوان نقش الزامی است.",
      });
    }

    const duplicate = await db.query(
      `SELECT id FROM roles WHERE LOWER(TRIM(code)) = LOWER(TRIM($1)) LIMIT 1`,
      [cleanCode]
    );
    if (duplicate.rowCount > 0) {
      return res.status(400).json({
        success: false,
        message: "این کد نقش قبلا ثبت شده است",
      });
    }

    const result = await db.query(
      `
      INSERT INTO roles (member_id, code, title, description, is_active, is_system)
      VALUES ($1, $2, $3, $4, $5, false)
      RETURNING *
      `,
      [ownerId, cleanCode, cleanTitle, description || "", parseBoolean(is_active, true)]
    );

    return res.json({
      success: true,
      data: result.rows[0],
      message: "نقش جدید با موفقیت ایجاد شد",
    });
  } catch (error) {
    console.error("❌ Error creating role:", error);
    return res.status(500).json({
      success: false,
      message: "خطای دیتابیس: " + error.message,
    });
  }
});

// ویرایش نقش
router.put("/roles/:id", requirePermission("settings.roles.edit"), async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, is_active } = req.body;

    const roleCheck = await db.query(`SELECT id, is_system FROM roles WHERE id = $1`, [id]);
    if (roleCheck.rowCount === 0) {
      return res.status(404).json({ success: false, message: "نقش یافت نشد." });
    }

    if (roleCheck.rows[0].is_system) {
      return res.status(400).json({
        success: false,
        message: "نقش سیستمی قابل ویرایش نیست.",
      });
    }

    const cleanTitle = String(title || "").trim();
    if (!cleanTitle) {
      return res.status(400).json({
        success: false,
        message: "عنوان نقش الزامی است.",
      });
    }

    await db.query(
      `
      UPDATE roles
      SET title = $1, description = $2, is_active = $3, updated_at = NOW()
      WHERE id = $4
      `,
      [cleanTitle, description || "", parseBoolean(is_active, true), id]
    );

    return res.json({ success: true, message: "نقش با موفقیت ویرایش شد" });
  } catch (error) {
    console.error("❌ Error updating role:", error);
    return res.status(500).json({ success: false, message: "خطا در ویرایش نقش" });
  }
});

// حذف نقش
router.delete("/roles/:id", requirePermission("settings.roles.delete"), async (req, res) => {
  const client = await db.connect();
  try {
    const { id } = req.params;

    const roleCheck = await client.query(`SELECT id, is_system FROM roles WHERE id = $1`, [id]);
    if (roleCheck.rowCount === 0) {
      return res.status(404).json({ success: false, message: "نقش یافت نشد." });
    }

    if (roleCheck.rows[0].is_system) {
      return res.status(400).json({
        success: false,
        message: "نقش سیستمی قابل حذف نیست.",
      });
    }

    const userCheck = await client.query(
      `SELECT COUNT(*)::int AS count FROM user_roles WHERE role_id = $1 AND is_active = true`,
      [id]
    );
    if (userCheck.rows[0].count > 0) {
      return res.status(400).json({
        success: false,
        message: "این نقش به کاربرانی اختصاص داده شده و قابل حذف نیست.",
      });
    }

    await client.query("BEGIN");
    await client.query(`DELETE FROM role_permissions WHERE role_id = $1`, [id]);
    await client.query(`DELETE FROM roles WHERE id = $1`, [id]);
    await client.query("COMMIT");

    return res.json({ success: true, message: "نقش با موفقیت حذف شد" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Error deleting role:", error);
    return res.status(500).json({ success: false, message: "خطا در حذف نقش" });
  } finally {
    client.release();
  }
});

// ==================================================================
// 4) مدیریت کل پرمیشن‌های سیستم
// ==================================================================
router.get("/permissions", requirePermission("settings.roles.view"), async (_req, res) => {
  try {
    const result = await db.query(`SELECT * FROM permissions ORDER BY module, action`);

    const grouped = result.rows.reduce((acc, perm) => {
      if (!acc[perm.module]) acc[perm.module] = [];
      acc[perm.module].push(perm);
      return acc;
    }, {});

    return res.json({ success: true, data: result.rows, grouped });
  } catch (error) {
    console.error("❌ Error fetching permissions:", error);
    return res.status(500).json({
      success: false,
      message: "خطا در دریافت لیست دسترسی‌ها",
    });
  }
});

// ==================================================================
// 5) تخصیص نقش به کاربران (User Role Assignment)
// ==================================================================

router.get(
  "/users/:userId/roles",
  requirePermission("settings.user-roles.view"),
  async (req, res) => {
    try {
      const { userId } = req.params;

      const query = `
      SELECT ur.*, r.title AS role_title, r.code AS role_code
      FROM user_roles ur
      JOIN roles r ON ur.role_id = r.id
      WHERE (ur.member_id = $1 OR ur.user_id = $1)
      ORDER BY ur.created_at DESC
    `;
      const result = await db.query(query, [userId]);
      return res.json({ success: true, data: result.rows });
    } catch (error) {
      console.error("❌ Error fetching user roles:", error);
      return res.status(500).json({
        success: false,
        message: "خطا در دریافت نقش‌های کاربر",
      });
    }
  }
);

router.post(
  "/users/:userId/roles",
  requirePermission("settings.user-roles.create"),
  async (req, res) => {
    try {
      const { userId } = req.params;
      const { role_id, valid_from, valid_to } = req.body;

      if (!role_id) {
        return res.status(400).json({
          success: false,
          message: "role_id الزامی است.",
        });
      }

      if (valid_from && valid_to && new Date(valid_to) < new Date(valid_from)) {
        return res.status(400).json({
          success: false,
          message: "تاریخ پایان نمی‌تواند قبل از تاریخ شروع باشد.",
        });
      }

      const roleCheck = await db.query(`SELECT id FROM roles WHERE id = $1 LIMIT 1`, [role_id]);
      if (roleCheck.rowCount === 0) {
        return res.status(400).json({
          success: false,
          message: "نقش انتخاب‌شده معتبر نیست.",
        });
      }

      const duplicateCheck = await db.query(
        `
      SELECT id
      FROM user_roles
      WHERE role_id = $1
        AND (member_id = $2 OR user_id = $2)
        AND is_active = true
        AND (valid_to IS NULL OR valid_to >= NOW())
      LIMIT 1
      `,
        [role_id, userId]
      );
      if (duplicateCheck.rowCount > 0) {
        return res.status(400).json({
          success: false,
          message: "این نقش قبلا به کاربر اختصاص داده شده است.",
        });
      }

      const result = await db.query(
        `
      INSERT INTO user_roles (member_id, user_id, role_id, valid_from, valid_to, is_active)
      VALUES ($1, $1, $2, $3, $4, true)
      RETURNING *
      `,
        [userId, role_id, valid_from || new Date(), valid_to || null]
      );

      return res.json({ success: true, data: result.rows[0] });
    } catch (error) {
      console.error("❌ Error assigning role:", error);
      return res.status(500).json({ success: false, message: "خطا در اختصاص نقش" });
    }
  }
);

router.delete(
  "/users/:userId/roles/:roleId",
  requirePermission("settings.user-roles.delete"),
  async (req, res) => {
    try {
      const { userId, roleId } = req.params;

      await db.query(
        `DELETE FROM user_roles WHERE (member_id = $1 OR user_id = $1) AND role_id = $2`,
        [userId, roleId]
      );

      return res.json({ success: true, message: "نقش حذف شد" });
    } catch (error) {
      console.error("❌ Error deleting user-role:", error);
      return res.status(500).json({ success: false, message: "خطا در حذف نقش" });
    }
  }
);

// ==================================================================
// 6) مدیریت دسترسی‌های یک نقش
// ==================================================================
router.get(
  "/roles/:roleId/permissions",
  requirePermission("settings.roles.view"),
  async (req, res) => {
    try {
      const { roleId } = req.params;

      const result = await db.query(
        `SELECT permission_id FROM role_permissions WHERE role_id = $1`,
        [roleId]
      );

      return res.json({ success: true, data: result.rows });
    } catch (error) {
      console.error("❌ Error fetching role permissions:", error);
      return res.status(500).json({
        success: false,
        message: "خطا در دریافت دسترسی‌های نقش",
      });
    }
  }
);

router.put(
  "/roles/:roleId/permissions",
  requirePermission("settings.roles.edit"),
  async (req, res) => {
    const client = await db.connect();

    try {
      const { roleId } = req.params;
      const { permissions } = req.body;

      const roleCheck = await client.query(`SELECT id FROM roles WHERE id = $1`, [roleId]);
      if (roleCheck.rowCount === 0) {
        return res.status(404).json({ success: false, message: "نقش یافت نشد." });
      }

      const permissionIds = [...new Set(
        (Array.isArray(permissions) ? permissions : [])
          .map((p) =>
            p && typeof p === "object" ? p.permission_id ?? p.id : p
          )
          .filter(Boolean)
          .map((id) => String(id).trim())
      )];

      // اعتبارسنجی شناسه‌های permission
      if (permissionIds.length > 0) {
        const validPerms = await client.query(
          `SELECT id::text AS id FROM permissions WHERE id::text = ANY($1::text[])`,
          [permissionIds]
        );
        const validSet = new Set(validPerms.rows.map((r) => r.id));
        const invalidIds = permissionIds.filter((id) => !validSet.has(id));

        if (invalidIds.length > 0) {
          return res.status(400).json({
            success: false,
            message: `permission_id نامعتبر: ${invalidIds.join(", ")}`,
          });
        }
      }

      await client.query("BEGIN");
      await client.query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]);

      for (const permissionId of permissionIds) {
        await client.query(
          `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)`,
          [roleId, permissionId]
        );
      }

      await client.query("COMMIT");
      return res.json({ success: true, message: "دسترسی‌های نقش بروزرسانی شد" });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("❌ Error updating role permissions:", error);
      return res.status(500).json({
        success: false,
        message: "خطا در بروزرسانی دسترسی‌ها",
      });
    } finally {
      client.release();
    }
  }
);

module.exports = router;