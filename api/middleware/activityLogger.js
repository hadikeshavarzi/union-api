const { logActivity } = require('../activityLog');

const ACTION_MAP = {
    'POST /api/receipts': { action: 'create', entity: 'receipt', desc: 'ثبت رسید جدید' },
    'PUT /api/receipts': { action: 'update', entity: 'receipt', desc: 'ویرایش رسید' },
    'DELETE /api/receipts': { action: 'delete', entity: 'receipt', desc: 'حذف رسید' },
    'POST /api/clearances': { action: 'create', entity: 'clearance', desc: 'ثبت ترخیص جدید' },
    'PUT /api/clearances': { action: 'update', entity: 'clearance', desc: 'ویرایش ترخیص' },
    'DELETE /api/clearances': { action: 'delete', entity: 'clearance', desc: 'حذف ترخیص' },
    'POST /api/loadings': { action: 'create', entity: 'loading', desc: 'ثبت بارگیری جدید' },
    'PUT /api/loadings': { action: 'update', entity: 'loading', desc: 'ویرایش بارگیری' },
    'DELETE /api/loadings': { action: 'delete', entity: 'loading', desc: 'حذف بارگیری' },
    'POST /api/exits': { action: 'create', entity: 'exit', desc: 'ثبت خروجی جدید' },
    'PUT /api/exits': { action: 'update', entity: 'exit', desc: 'ویرایش خروجی' },
    'DELETE /api/exits': { action: 'delete', entity: 'exit', desc: 'حذف خروجی' },
    'POST /api/accounting': { action: 'create', entity: 'accounting', desc: 'ثبت سند حسابداری' },
    'PUT /api/accounting': { action: 'update', entity: 'accounting', desc: 'ویرایش سند حسابداری' },
    'POST /api/treasury': { action: 'create', entity: 'treasury', desc: 'ثبت سند خزانه' },
    'POST /api/rentals': { action: 'create', entity: 'rental', desc: 'ثبت قرارداد اجاره' },
    'PUT /api/rentals': { action: 'update', entity: 'rental', desc: 'ویرایش قرارداد اجاره' },
    'DELETE /api/rentals': { action: 'delete', entity: 'rental', desc: 'حذف قرارداد اجاره' },
    'POST /api/customers': { action: 'create', entity: 'customer', desc: 'ثبت مشتری جدید' },
    'PUT /api/customers': { action: 'update', entity: 'customer', desc: 'ویرایش مشتری' },
    'DELETE /api/customers': { action: 'delete', entity: 'customer', desc: 'حذف مشتری' },
    'POST /api/products': { action: 'create', entity: 'product', desc: 'ثبت کالای جدید' },
    'PUT /api/products': { action: 'update', entity: 'product', desc: 'ویرایش کالا' },
    'DELETE /api/products': { action: 'delete', entity: 'product', desc: 'حذف کالا' },
    'POST /api/settings': { action: 'update', entity: 'settings', desc: 'بروزرسانی تنظیمات' },
    'POST /api/calendar/events': { action: 'create', entity: 'calendar_event', desc: 'ثبت رویداد تقویم' },
    'PUT /api/calendar/events': { action: 'update', entity: 'calendar_event', desc: 'ویرایش رویداد تقویم' },
    'DELETE /api/calendar/events': { action: 'delete', entity: 'calendar_event', desc: 'حذف رویداد تقویم' },
};

const activityLogger = (req, res, next) => {
    if (req.method === 'GET') return next();

    const originalJson = res.json.bind(res);

    res.json = function(body) {
        try {
            if (req.user?.member_id && res.statusCode < 400) {
                const urlPath = req.originalUrl.split('?')[0];
                const basePath = urlPath
                    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, '')
                    .replace(/\/\d+$/, '');
                const key = `${req.method} ${basePath}`;
                const mapping = ACTION_MAP[key];

                if (mapping) {
                    const entityId = req.params?.id || body?.data?.id || req.body?.id;
                    logActivity(req, mapping.action, mapping.entity, entityId, mapping.desc, {
                        method: req.method,
                        path: urlPath,
                    });
                }
            }
        } catch (e) {
            // silent
        }

        return originalJson(body);
    };

    next();
};

module.exports = activityLogger;
