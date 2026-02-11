// api/exits.js (Converted to PostgreSQL)
const express = require("express");
const { pool } = require("../supabaseAdmin"); // استفاده از pool به جای supabaseAdmin
// حذف یکی از نقاط چون نیازی به برگشت به پوشه قبل نیست
const authMiddleware = require("./middleware/auth");
const router = express.Router();

/* ============================================================
   Helpers (SQL Versions)
============================================================ */

// تبدیل آرایه ID ها به Map برای دسترسی سریع
async function pickMapById(client, table, ids, selectCols = "*") {
    if (!ids || ids.length === 0) return {};
    // تبدیل ids به آرایه یونیک و حذف null
    const uniqueIds = [...new Set(ids.filter(Boolean))];
    if (uniqueIds.length === 0) return {};

    const query = `SELECT ${selectCols} FROM public.${table} WHERE id = ANY($1::int[])`;
    const { rows } = await client.query(query, [uniqueIds]);

    const map = {};
    rows.forEach(row => { map[row.id] = row; });
    return map;
}

// تولید شماره خروج
async function generateExitNo(client, memberId) {
    const { rows } = await client.query(
        `SELECT COUNT(*) as count FROM public.warehouse_exits WHERE member_id = $1`,
        [memberId]
    );
    const count = Number(rows[0]?.count || 0);
    return (Number(memberId) * 1000) + 9000 + (count + 1);
}

function toNum(v, d = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
}

/* ============================================================
   1) GET /api/exits  لیست خروجی‌ها
============================================================ */
router.get("/", authMiddleware, async (req, res) => {
    try {
        const memberId = req.user.id; // فرض بر اینکه id عددی است، اگر authMiddleware آیدی عددی ست می‌کند

        // دریافت لیست خروج‌ها
        const { rows: exits } = await pool.query(
            `SELECT * FROM public.warehouse_exits WHERE member_id = $1 ORDER BY created_at DESC`,
            [memberId]
        );

        if (exits.length === 0) return res.json({ success: true, data: [] });

        // جمع‌آوری ID ها برای کوئری‌های بعدی
        const loadingOrderIds = exits.map(e => e.loading_order_id);
        const ownerIds = exits.map(e => e.owner_id);
        const exitIds = exits.map(e => e.id);

        // دریافت اطلاعات تکمیلی به صورت موازی
        const [loadingOrdersMap, customersMap] = await Promise.all([
            pickMapById(pool, "loading_orders", loadingOrderIds, "id,order_no"),
            pickMapById(pool, "customers", ownerIds, "id,name")
        ]);

        // دریافت آیتم‌های خروج
        const { rows: allItems } = await pool.query(
            `SELECT * FROM public.warehouse_exit_items WHERE warehouse_exit_id = ANY($1::int[])`,
            [exitIds]
        );

        // دریافت اطلاعات کالای مرتبط با آیتم‌ها
        const loadingItemIds = allItems.map(i => i.loading_item_id);
        const loadingItemsMap = await pickMapById(pool, "loading_order_items", loadingItemIds, "id,batch_no,product_id,qty");

        const productIds = Object.values(loadingItemsMap).map(li => li.product_id);
        const productsMap = await pickMapById(pool, "products", productIds, "id,name");

        // گروه‌بندی آیتم‌ها بر اساس exit_id
        const itemsByExit = {};
        allItems.forEach(it => {
            if (!itemsByExit[it.warehouse_exit_id]) itemsByExit[it.warehouse_exit_id] = [];

            const li = loadingItemsMap[it.loading_item_id];
            const pr = li ? productsMap[li.product_id] : null;

            itemsByExit[it.warehouse_exit_id].push({
                id: it.id,
                qty: it.qty,
                weight_net: it.weight_net,
                fee_price: it.fee_price,
                loading_fee: it.loading_fee,
                final_fee: it.final_fee,
                loading_item: {
                    batch_no: li?.batch_no,
                    product: { name: pr?.name },
                },
            });
        });

        // فرمت نهایی
        const result = exits.map(e => ({
            ...e,
            loading_order: e.loading_order_id ? { order_no: loadingOrdersMap[e.loading_order_id]?.order_no } : null,
            customer: e.owner_id ? { name: customersMap[e.owner_id]?.name } : null,
            items: itemsByExit[e.id] || [],
        }));

        return res.json({ success: true, data: result });

    } catch (e) {
        console.error("❌ Get Exits Error:", e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   2) GET /api/exits/search/:term
============================================================ */
router.get("/search/:term", authMiddleware, async (req, res) => {
    try {
        const term = req.params.term;
        const memberId = req.user.id;

        let exitRecord = null;
        let loadingOrderRecord = null;

        // A) جستجو در loading_orders
        const { rows: loRows } = await pool.query(
            `SELECT * FROM public.loading_orders WHERE order_no = $1 AND member_id = $2`,
            [term, memberId]
        );

        if (loRows.length > 0) {
            const loadingOrder = loRows[0];
            // چک کنیم آیا خروج دارد؟
            const { rows: exRows } = await pool.query(
                `SELECT * FROM public.warehouse_exits WHERE loading_order_id = $1 AND member_id = $2`,
                [loadingOrder.id, memberId]
            );

            if (exRows.length > 0) exitRecord = exRows[0];
            else loadingOrderRecord = loadingOrder;
        }

        // B) جستجو با ID خروج (اگر پیدا نشد و term عدد بود)
        if (!exitRecord && !loadingOrderRecord && !isNaN(term)) {
            const { rows: exRows } = await pool.query(
                `SELECT * FROM public.warehouse_exits WHERE id = $1 AND member_id = $2`,
                [term, memberId]
            );
            if (exRows.length > 0) exitRecord = exRows[0];
        }

        if (!exitRecord && !loadingOrderRecord) {
            return res.status(404).json({ success: false, message: "سندی یافت نشد." });
        }

        // --- حالت ۱: نمایش سند خروج موجود ---
        if (exitRecord) {
            // دریافت اطلاعات وابسته
            const [loMap, custMap] = await Promise.all([
                pickMapById(pool, "loading_orders", [exitRecord.loading_order_id], "*"),
                pickMapById(pool, "customers", [exitRecord.owner_id], "id,name")
            ]);

            const { rows: exitItems } = await pool.query(`SELECT * FROM public.warehouse_exit_items WHERE warehouse_exit_id = $1`, [exitRecord.id]);

            const liMap = await pickMapById(pool, "loading_order_items", exitItems.map(i => i.loading_item_id), "*");
            const prodMap = await pickMapById(pool, "products", Object.values(liMap).map(i => i.product_id), "*");

            const formattedItems = exitItems.map(it => {
                const li = liMap[it.loading_item_id];
                const pr = li ? prodMap[li.product_id] : null;
                return {
                    item_id: it.loading_item_id,
                    product_name: pr?.name || "نامشخص",
                    batch_no: li?.batch_no,
                    qty: toNum(it.qty),
                    entry_date: it.created_at, // ساده‌سازی
                    fee_type: pr?.fee_type || "weight",
                    base_storage_rate: toNum(pr?.effective_storage_cost),
                    base_loading_rate: toNum(pr?.effective_loading_cost),
                    weight_full: toNum(it.weight_full),
                    weight_empty: toNum(it.weight_empty),
                    weight_net: toNum(it.weight_net),
                    row_storage_fee: toNum(it.final_fee),
                    row_loading_fee: toNum(it.loading_fee),
                };
            });

            return res.json({
                success: true,
                data: {
                    source: "exit_record",
                    is_processed: true,
                    status: exitRecord.status,
                    exit_id: exitRecord.id,
                    loading_id: exitRecord.loading_order_id,
                    order_no: loMap[exitRecord.loading_order_id]?.order_no,
                    driver_name: exitRecord.driver_name,
                    plate_number: exitRecord.plate_number,
                    customer_name: custMap[exitRecord.owner_id]?.name,
                    customer_id: exitRecord.owner_id,
                    weighbridge_fee: exitRecord.weighbridge_fee,
                    extra_fee: exitRecord.extra_fee,
                    payment_method: exitRecord.payment_method,
                    items: formattedItems
                }
            });
        }

        // --- حالت ۲: نمایش loading order برای ثبت خروج جدید ---
        if (loadingOrderRecord) {
            const { rows: loadItems } = await pool.query(`SELECT * FROM public.loading_order_items WHERE loading_order_id = $1`, [loadingOrderRecord.id]);
            const prodMap = await pickMapById(pool, "products", loadItems.map(i => i.product_id), "*");

            const formattedItems = loadItems.map(li => {
                const pr = prodMap[li.product_id];
                return {
                    item_id: li.id,
                    product_name: pr?.name,
                    batch_no: li.batch_no,
                    qty: toNum(li.qty),
                    entry_date: new Date().toISOString(),
                    fee_type: pr?.fee_type || "weight",
                    base_storage_rate: toNum(pr?.effective_storage_cost),
                    base_loading_rate: toNum(pr?.effective_loading_cost),
                    weight_full: 0, weight_empty: 0, weight_net: 0,
                    row_storage_fee: 0, row_loading_fee: 0
                };
            });

            return res.json({
                success: true,
                data: {
                    source: "loading_order",
                    is_processed: false,
                    loading_id: loadingOrderRecord.id,
                    order_no: loadingOrderRecord.order_no,
                    driver_name: loadingOrderRecord.driver_name,
                    plate_number: loadingOrderRecord.plate_number,
                    customer_id: loadingOrderRecord.customer_id,
                    items: formattedItems
                }
            });
        }

    } catch (e) {
        console.error("❌ Search Error:", e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   3) POST /api/exits   ثبت خروج (Transactional)
============================================================ */
router.post("/", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const memberId = req.user.id;
        const payload = req.body;

        await client.query('BEGIN'); // 🚀 شروع تراکنش

        const exitNo = await generateExitNo(client, memberId);

        // ۱. ثبت هدر
        const headerQuery = `
            INSERT INTO public.warehouse_exits (
                member_id, exit_no, loading_order_id, owner_id, driver_name, plate_number,
                exit_date, reference_no, driver_national_code, weighbridge_fee, extra_fee, extra_description,
                vat_fee, total_fee, total_loading_fee, payment_method, financial_account_id, status, description
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
            ) RETURNING *
        `;
        const headerValues = [
            memberId, exitNo, payload.loading_order_id, payload.owner_id, payload.driver_name, payload.plate_number,
            payload.exit_date, payload.reference_no, payload.driver_national_code,
            toNum(payload.weighbridge_fee), toNum(payload.extra_fee), payload.extra_description,
            toNum(payload.vat_fee), toNum(payload.total_fee), toNum(payload.total_loading_fee),
            payload.payment_method, payload.financial_account_id, payload.status,
            payload.status === "draft" ? "ثبت موقت" : "ثبت نهایی"
        ];

        const { rows: [header] } = await client.query(headerQuery, headerValues);

        // ۲. ثبت آیتم‌ها
        for (const item of (payload.items || [])) {
            await client.query(`
                INSERT INTO public.warehouse_exit_items (
                    warehouse_exit_id, loading_item_id, weight_full, weight_empty, weight_net,
                    qty, fee_type, fee_price, loading_fee, final_fee
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            `, [
                header.id, item.item_id, toNum(item.weight_full), toNum(item.weight_empty), toNum(item.weight_net),
                toNum(item.qty), item.fee_type || 'weight', toNum(item.base_storage_rate),
                toNum(item.row_loading_fee), toNum(item.row_storage_fee)
            ]);
        }

        // ۳. آپدیت وضعیت دستور بارگیری (اگر نهایی بود)
        if (payload.status === "final" && payload.loading_order_id) {
            await client.query(`UPDATE public.loading_orders SET status = 'exited' WHERE id = $1`, [payload.loading_order_id]);
        }

        await client.query('COMMIT'); // ✅ پایان موفق

        return res.json({ success: true, id: header.id, message: "خروج با موفقیت ثبت شد" });

    } catch (e) {
        await client.query('ROLLBACK'); // ❌ بازگشت در صورت خطا
        console.error("❌ Post Exit Error:", e.message);
        return res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

/* ============================================================
   4) GET /api/exits/:id   جزئیات برای پرینت
============================================================ */
router.get("/:id", authMiddleware, async (req, res) => {
    try {
        const exitId = req.params.id;
        const memberId = req.user.id;

        const { rows } = await pool.query(
            `SELECT * FROM public.warehouse_exits WHERE id = $1 AND member_id = $2`,
            [exitId, memberId]
        );

        if (rows.length === 0) return res.status(404).json({ success: false, error: "سند یافت نشد" });
        const header = rows[0];

        // دریافت اطلاعات وابسته
        const [loMap, custMap] = await Promise.all([
            pickMapById(pool, "loading_orders", [header.loading_order_id], "id,order_no"),
            pickMapById(pool, "customers", [header.owner_id], "id,name")
        ]);

        const { rows: exitItems } = await pool.query(
            `SELECT * FROM public.warehouse_exit_items WHERE warehouse_exit_id = $1`,
            [header.id]
        );

        const liMap = await pickMapById(pool, "loading_order_items", exitItems.map(i => i.loading_item_id), "*");
        const prodMap = await pickMapById(pool, "products", Object.values(liMap).map(i => i.product_id), "id,name");

        const formattedItems = exitItems.map(it => {
            const li = liMap[it.loading_item_id];
            const pr = li ? prodMap[li.product_id] : null;
            return {
                ...it,
                product_name: pr?.name,
                batch_no: li?.batch_no,
                row_storage_fee: it.final_fee
            };
        });

        return res.json({
            success: true,
            data: {
                ...header,
                customer_name: custMap[header.owner_id]?.name,
                order_no: loMap[header.loading_order_id]?.order_no,
                items: formattedItems
            }
        });

    } catch (e) {
        console.error("❌ Get Exit ID Error:", e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   5) DELETE /api/exits/:id   حذف سند خروج (Transactional)
============================================================ */
router.delete("/:id", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const exitId = req.params.id;
        const memberId = req.user.id;

        await client.query('BEGIN');

        // چک کردن مالکیت
        const { rows } = await client.query(
            `SELECT id, loading_order_id FROM public.warehouse_exits WHERE id = $1 AND member_id = $2`,
            [exitId, memberId]
        );
        if (rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: "سند یافت نشد یا دسترسی ندارید" });
        }
        const exitRecord = rows[0];

        // ۱. حذف آیتم‌ها
        await client.query(`DELETE FROM public.warehouse_exit_items WHERE warehouse_exit_id = $1`, [exitId]);

        // ۲. حذف هدر
        await client.query(`DELETE FROM public.warehouse_exits WHERE id = $1`, [exitId]);

        // ۳. بازگرداندن وضعیت دستور بارگیری
        if (exitRecord.loading_order_id) {
            await client.query(`UPDATE public.loading_orders SET status = 'issued' WHERE id = $1`, [exitRecord.loading_order_id]);
        }

        await client.query('COMMIT');

        return res.json({ success: true, message: "سند حذف شد." });

    } catch (e) {
        await client.query('ROLLBACK');
        console.error("❌ Delete Exit Error:", e.message);
        return res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

module.exports = router;