const supabase = require('../config/supabase');

/**
 * Middleware برای چک کردن دسترسی کاربر به یک عملیات خاص
 * @param {string} module - نام ماژول (مثل 'receipts', 'customers')
 * @param {string} action - نوع عملیات ('view', 'create', 'edit', 'delete')
 */
const checkPermission = (module, action) => {
  return async (req, res, next) => {
    try {
      const { member_id, id: user_id } = req.user;

      // دریافت نقش‌های فعال کاربر
      const { data: userRoles, error: rolesError } = await supabase
        .from('user_roles')
        .select('role_id')
        .eq('member_id', member_id)
        .eq('user_id', user_id)
        .eq('is_active', true)
        .lte('valid_from', new Date().toISOString())
        .or(`valid_to.is.null,valid_to.gte.${new Date().toISOString()}`);

      if (rolesError) throw rolesError;

      if (!userRoles || userRoles.length === 0) {
        return res.status(403).json({
          success: false,
          message: 'شما هیچ نقشی ندارید'
        });
      }

      const roleIds = userRoles.map(ur => ur.role_id);

      // چک کردن دسترسی
      const { data: permissions, error: permError } = await supabase
        .from('role_permissions')
        .select(`
          *,
          permissions!inner(*)
        `)
        .in('role_id', roleIds)
        .eq('permissions.module', module)
        .eq('permissions.action', action);

      if (permError) throw permError;

      if (!permissions || permissions.length === 0) {
        return res.status(403).json({
          success: false,
          message: `شما دسترسی ${action} به بخش ${module} را ندارید`
        });
      }

      // اضافه کردن اطلاعات دسترسی به request برای استفاده در controller
      req.userPermission = {
        module,
        action,
        constraints: permissions.map(p => p.constraints_json).filter(Boolean)
      };

      next();
    } catch (error) {
      console.error('Permission check error:', error);
      res.status(500).json({
        success: false,
        message: 'خطا در بررسی دسترسی',
        error: error.message
      });
    }
  };
};

/**
 * Middleware برای چک کردن دسترسی به یک فرم خاص
 * @param {string} formCode - کد فرم
 * @param {string} requiredFor - نوع دسترسی مورد نیاز
 */
const checkFormAccess = (formCode, requiredFor = 'view') => {
  return async (req, res, next) => {
    try {
      const { member_id, id: user_id } = req.user;

      // دریافت فرم
      const { data: form, error: formError } = await supabase
        .from('ui_forms')
        .select(`
          *,
          ui_form_permissions (
            *,
            permissions (*)
          )
        `)
        .eq('member_id', member_id)
        .eq('form_code', formCode)
        .eq('is_active', true)
        .single();

      if (formError || !form) {
        return res.status(404).json({
          success: false,
          message: 'فرم یافت نشد'
        });
      }

      // اگر فرم هیچ permission نداره، همه دسترسی دارند
      if (!form.ui_form_permissions || form.ui_form_permissions.length === 0) {
        req.formAccess = { allowed: true };
        return next();
      }

      // دریافت نقش‌های کاربر
      const { data: userRoles } = await supabase
        .from('user_roles')
        .select('role_id')
        .eq('member_id', member_id)
        .eq('user_id', user_id)
        .eq('is_active', true)
        .lte('valid_from', new Date().toISOString())
        .or(`valid_to.is.null,valid_to.gte.${new Date().toISOString()}`);

      if (!userRoles || userRoles.length === 0) {
        return res.status(403).json({
          success: false,
          message: 'شما دسترسی به این فرم را ندارید'
        });
      }

      const roleIds = userRoles.map(ur => ur.role_id);

      // پیدا کردن permission های مورد نیاز
      const requiredPermissions = form.ui_form_permissions
        .filter(fp => fp.required_for === requiredFor)
        .map(fp => fp.permission_id);

      if (requiredPermissions.length === 0) {
        req.formAccess = { allowed: true };
        return next();
      }

      // چک کردن دسترسی کاربر
      const { data: userPermissions } = await supabase
        .from('role_permissions')
        .select('permission_id')
        .in('role_id', roleIds)
        .in('permission_id', requiredPermissions);

      if (!userPermissions || userPermissions.length === 0) {
        return res.status(403).json({
          success: false,
          message: `شما دسترسی ${requiredFor} به این فرم را ندارید`
        });
      }

      req.formAccess = { allowed: true, form };
      next();
    } catch (error) {
      console.error('Form access check error:', error);
      res.status(500).json({
        success: false,
        message: 'خطا در بررسی دسترسی فرم',
        error: error.message
      });
    }
  };
};

/**
 * Helper function برای چک کردن دسترسی در controller ها
 */
const hasPermission = async (userId, memberId, module, action) => {
  try {
    const { data: userRoles } = await supabase
      .from('user_roles')
      .select('role_id')
      .eq('member_id', memberId)
      .eq('user_id', userId)
      .eq('is_active', true)
      .lte('valid_from', new Date().toISOString())
      .or(`valid_to.is.null,valid_to.gte.${new Date().toISOString()}`);

    if (!userRoles || userRoles.length === 0) return false;

    const roleIds = userRoles.map(ur => ur.role_id);

    const { data: permissions } = await supabase
      .from('role_permissions')
      .select(`
        *,
        permissions!inner(*)
      `)
      .in('role_id', roleIds)
      .eq('permissions.module', module)
      .eq('permissions.action', action);

    return permissions && permissions.length > 0;
  } catch (error) {
    console.error('hasPermission error:', error);
    return false;
  }
};

/**
 * Helper برای دریافت همه مجوزهای کاربر
 */
const getUserPermissions = async (userId, memberId) => {
  try {
    const { data: userRoles } = await supabase
      .from('user_roles')
      .select('role_id')
      .eq('member_id', memberId)
      .eq('user_id', userId)
      .eq('is_active', true)
      .lte('valid_from', new Date().toISOString())
      .or(`valid_to.is.null,valid_to.gte.${new Date().toISOString()}`);

    if (!userRoles || userRoles.length === 0) return {};

    const roleIds = userRoles.map(ur => ur.role_id);

    const { data: permissions } = await supabase
      .from('role_permissions')
      .select(`
        *,
        permissions (*)
      `)
      .in('role_id', roleIds);

    const permissionsMap = {};
    permissions.forEach(rp => {
      const key = `${rp.permissions.module}.${rp.permissions.action}`;
      if (!permissionsMap[key]) {
        permissionsMap[key] = {
          ...rp.permissions,
          constraints: []
        };
      }
      if (rp.constraints_json) {
        permissionsMap[key].constraints.push(rp.constraints_json);
      }
    });

    return permissionsMap;
  } catch (error) {
    console.error('getUserPermissions error:', error);
    return {};
  }
};

module.exports = {
  checkPermission,
  checkFormAccess,
  hasPermission,
  getUserPermissions
};