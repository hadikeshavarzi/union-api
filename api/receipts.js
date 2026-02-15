const express = require("express");
const router = express.Router();
const { pool } = require("../supabaseAdmin");
const authMiddleware = require("./middleware/auth");
const { generateReceiptAccounting } = require("./accounting/accountingAuto");

const isUUID = (str) => str && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

const toYMD = (v) => {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

const toNum = (v, fallback = 0) => {
    if (v === null || v === undefined || v === "") return fallback;
    const n = Number(String(v).replace(/,/g, ""));
    return Number.isFinite(n) ? n : fallback;
};

const toInt = (v, fallback) => {
    const n = Number.parseInt(String(v ?? ""), 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const buildListFilters = (query, values) => {
    const where = ["r.member_id = $1"];

    if (query.status) {
        values.push(String(query.status).trim());
        where.push(`r.status = $${values.length}`);
    }

    if (query.owner_id && isUUID(query.owner_id)) {
        values.push(query.owner_id);
        where.push(`r.owner_id = $${values.length}`);
    }

    const dateFrom = toYMD(query.date_from);
    if (dateFrom) {
        values.push(dateFrom);
        where.push(`r.doc_date >= $${values.length}`);
    }

    const dateTo = toYMD(query.date_to);
    if (dateTo) {
        values.push(dateTo);
        where.push(`r.doc_date <= $${values.length}`);
    }

    const search = String(query.search || "").trim();
    if (search) {
        values.push(`%${search}%`);
        const idx = values.length;
        where.push(`(
            CAST(r.receipt_no AS text) ILIKE $${idx}
            OR COALESCE(r.driver_name, '') ILIKE $${idx}
            OR COALESCE(c.name, '') ILIKE $${idx}
        )`);
    }

    return where.join(" AND ");
};

const getReceiptsListHandler = async (req, res) => {
    try {
        const memberId = req.user.member_id || req.user.id;
        const limit = Math.min(toInt(req.query.limit, 100), 500);
        const offset = toInt(req.query.offset, 0);

        const values = [memberId];
        const whereSql = buildListFilters(req.query, values);

        const listSql = `
            SELECT
                r.*,
                c.name AS owner_name,
                json_build_object(
                    'id', c.id,
                    'name', c.name,
                    'mobile', c.mobile,
                    'national_id', c.national_id,
                    'birth_date', c.birth_or_register_date,
                    'tafsili_id', c.tafsili_id
                ) AS owner,
                COALESCE(ri_stats.items_count, 0)::int AS items_count,
                COALESCE(ri_stats.total_weight, 0)::float8 AS total_weight
            FROM public.receipts r
            LEFT JOIN public.customers c ON c.id = r.owner_id
            LEFT JOIN LATERAL (
                SELECT
                    COUNT(*) AS items_count,
                    COALESCE(SUM(COALESCE(ri.weights_net, 0)), 0) AS total_weight
                FROM public.receipt_items ri
                WHERE ri.receipt_id = r.id
            ) ri_stats ON TRUE
            WHERE ${whereSql}
            ORDER BY r.doc_date DESC NULLS LAST, r.created_at DESC
            LIMIT $${values.length + 1} OFFSET $${values.length + 2};
        `;

        const listParams = [...values, limit, offset];

        const countSql = `
            SELECT COUNT(*)::int AS total
            FROM public.receipts r
            LEFT JOIN public.customers c ON c.id = r.owner_id
            WHERE ${whereSql};
        `;

        const [listRes, countRes] = await Promise.all([
            pool.query(listSql, listParams),
            pool.query(countSql, values),
        ]);

        res.json({
            success: true,
            data: {
                items: listRes.rows,
                total: countRes.rows[0]?.total || 0,
                limit,
                offset,
            },
        });
    } catch (e) {
        console.error("❌ GET Receipts Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
};

// =====================================================================
// GET /api/receipts
// GET /api/receipts/list
// =====================================================================
router.get("/", authMiddleware, getReceiptsListHandler);
router.get("/list", authMiddleware, getReceiptsListHandler);

// =====================================================================
// GET /api/receipts/:id
// =====================================================================
router.get("/:id", authMiddleware, async (req, res) => {
    try {
        const memberId = req.user.member_id || req.user.id;
        const { id } = req.params;

        if (!isUUID(id)) {
            return res.status(400).json({ success: false, error: "شناسه رسید نامعتبر است" });
        }

        const headerSql = `
            SELECT
                r.*,
                c.name AS owner_name,
                json_build_object(
                    'id', c.id,
                    'name', c.name,
                    'mobile', c.mobile,
                    'national_id', c.national_id,
                    'birth_date', c.birth_or_register_date,
                    'tafsili_id', c.tafsili_id
                ) AS owner
            FROM public.receipts r
            LEFT JOIN public.customers c ON c.id = r.owner_id
            WHERE r.id = $1 AND r.member_id = $2
            LIMIT 1;
        `;

        const headerRes = await pool.query(headerSql, [id, memberId]);

        if (headerRes.rows.length === 0) {
            return res.status(404).json({ success: false, error: "رسید یافت نشد" });
        }

        const itemsSql = `
            SELECT *
            FROM public.receipt_items
            WHERE receipt_id = $1
            ORDER BY created_at ASC, id ASC;
        `;

        const itemsRes = await pool.query(itemsSql, [id]);

        res.json({
            success: true,
            data: {
                ...headerRes.rows[0],
                items: itemsRes.rows,
            },
        });
    } catch (e) {
        console.error("❌ GET Receipt By ID Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// =====================================================================
// POST /api/receipts (ثبت رسید + ثبت قطعی مقادیر کالا در receipt_items)
// =====================================================================
router.post("/", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const member_id = req.user.id;
        const b = req.body || {};

        if (!b.owner_id || !isUUID(b.owner_id)) {
            return res.status(400).json({ success: false, error: "مالک کالا الزامی است" });
        }

        await client.query("BEGIN");

        let finalDocTypeId = b.doc_type_id;
        if (!finalDocTypeId || !isUUID(finalDocTypeId)) {
            const dtRes = await client.query("SELECT id FROM public.document_types WHERE name ILIKE '%رسید%' LIMIT 1");
            if (dtRes.rows.length > 0) finalDocTypeId = dtRes.rows[0].id;
            else throw new Error("نوع سند یافت نشد");
        }

        const maxRes = await client.query("SELECT COALESCE(MAX(receipt_no::bigint), 1000) as max_no FROM public.receipts");
        const nextNo = (Number(maxRes.rows[0].max_no) + 1).toString();

        const doc_date = toYMD(b.doc_date) || toYMD(new Date());

        const insertHeaderSql = `
            INSERT INTO public.receipts (
                doc_type_id, receipt_no, member_id, owner_id, status, doc_date,
                driver_name, driver_national_id, driver_phone,
                plate_iran_right, plate_mid3, plate_letter, plate_left2,
                tracking_code, discharge_date, deliverer_id,
                cost_load, cost_unload, cost_warehouse, cost_tax, cost_loading_fee, cost_return_freight, cost_misc, cost_misc_desc,
                payment_by, payment_amount, payment_source_id, payment_source_type,
                created_at, updated_at
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
                $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, NOW(), NOW()
            ) RETURNING id;
        `;

        const headerRes = await client.query(insertHeaderSql, [
            finalDocTypeId, nextNo, member_id, b.owner_id, b.status || "final", doc_date,
            b.driver_name, b.driver_national_id, b.driver_phone,
            b.plate?.right2 || b.plate_iran_right, b.plate?.middle3 || b.plate_mid3, b.plate?.letter || b.plate_letter, b.plate?.left2 || b.plate_left2,
            b.tracking_code, toYMD(b.discharge_date), (b.deliverer_id && isUUID(b.deliverer_id)) ? b.deliverer_id : null,
            toNum(b.cost_load || b.costs?.loadCost), toNum(b.cost_unload || b.costs?.unloadCost), toNum(b.cost_warehouse || b.costs?.warehouseCost),
            toNum(b.cost_tax || b.costs?.tax), toNum(b.cost_loading_fee || b.costs?.loadingFee), toNum(b.cost_return_freight || b.costs?.returnFreight),
            toNum(b.cost_misc || b.costs?.miscCost), b.cost_misc_desc || b.costs?.miscDescription,
            b.payment_by, toNum(b.payment_amount || b.payment?.info?.amount), b.payment_source_id, b.payment_source_type
        ]);

        const newReceiptId = headerRes.rows[0].id;

        const items = Array.isArray(b.items) ? b.items : [];
        for (const item of items) {
            if (!item.product_id || !isUUID(item.product_id)) continue;

            const qty = toNum(item.qty || item.count);
            const wFull = toNum(item.weights_full);
            const wEmpty = toNum(item.weights_empty);
            const wNet = wFull - wEmpty;

            const itemSql = `
                INSERT INTO public.receipt_items (
                    receipt_id, owner_id, member_id, product_id,
                    count, weights_full, weights_empty, weights_net, weights_origin, weights_diff,
                    production_type, is_used, is_defective,
                    dim_length, dim_width, dim_thickness,
                    heat_number, bundle_no, brand, order_no, depo_location, description_notes,
                    row_code, parent_row,
                    created_at, updated_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, NOW(), NOW()
                ) RETURNING id;
            `;

            const itemRes = await client.query(itemSql, [
                newReceiptId, b.owner_id, member_id, item.product_id,
                qty, wFull, wEmpty, wNet, toNum(item.weights_origin), toNum(item.weights_diff),
                item.production_type || "domestic", item.is_used === true, item.is_defective === true,
                toNum(item.dim_length), toNum(item.dim_width), toNum(item.dim_thickness),
                item.heat_number, item.bundle_no, item.brand, item.order_no, item.depo_location, item.description_notes,
                item.row_code || "", item.parent_row || ""
            ]);

            const newItemId = itemRes.rows[0].id;

            if (b.status !== "draft") {
                // batch_no = row_code (شماره ردیف) اگر وجود داشته باشه، وگرنه bundle_no یا heat_number
                const batchNo = item.row_code || item.bundle_no || item.heat_number || "";
                await client.query(`
                    INSERT INTO public.inventory_transactions (
                        type, transaction_type, ref_receipt_id, reference_id,
                        product_id, owner_id, member_id,
                        qty, weight, qty_real, weight_real, qty_available, weight_available,
                        batch_no, transaction_date, created_at, updated_at
                    ) VALUES ('in', 'havaleh', $1, $2, $3, $4, $5, $6, $7, $6, $7, $6, $7, $8, $9, NOW(), NOW());
                `, [
                    newReceiptId, newItemId, item.product_id, b.owner_id, member_id,
                    qty, wNet, batchNo, doc_date
                ]);
            }
        }

        if (b.status === "final") {
            try {
                await generateReceiptAccounting(client, {
                    receiptId: newReceiptId, receiptNo: nextNo, memberId: member_id, ownerId: b.owner_id, docDate: doc_date,
                    loadCost: toNum(b.cost_load), unloadCost: toNum(b.cost_unload), warehouseCost: toNum(b.cost_warehouse),
                    tax: toNum(b.cost_tax), loadingFee: toNum(b.cost_loading_fee), returnFreight: toNum(b.cost_return_freight),
                    miscCost: toNum(b.cost_misc), paymentBy: b.payment_by || "customer"
                });
            } catch (accErr) {
                console.error("⚠️ Accounting Error:", accErr.message);
            }
        }

        await client.query("COMMIT");
        res.json({ success: true, data: { id: newReceiptId, receipt_no: nextNo } });

    } catch (e) {
        await client.query("ROLLBACK");
        console.error("❌ Postgres Receipt Insert Error:", e);
        res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

// =====================================================================
// PUT /api/receipts/:id  (ویرایش رسید + نهایی‌سازی draft)
// =====================================================================
router.put("/:id", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const member_id = req.user.id;
        const receiptId = req.params.id;
        const b = req.body || {};

        if (!isUUID(receiptId)) {
            return res.status(400).json({ success: false, error: "شناسه رسید نامعتبر است" });
        }

        await client.query("BEGIN");

        // بررسی وجود رسید
        const existing = await client.query(
            "SELECT id, status, receipt_no FROM public.receipts WHERE id = $1 AND member_id = $2",
            [receiptId, member_id]
        );
        if (existing.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ success: false, error: "رسید یافت نشد" });
        }

        const oldStatus = existing.rows[0].status;
        const receiptNo = existing.rows[0].receipt_no;
        const newStatus = b.status || oldStatus;
        const doc_date = toYMD(b.doc_date) || toYMD(new Date());

        // آپدیت هدر رسید
        const updateHeaderSql = `
            UPDATE public.receipts SET
                status = $1, doc_date = $2,
                owner_id = $3,
                driver_name = $4, driver_national_id = $5, driver_phone = $6,
                plate_iran_right = $7, plate_mid3 = $8, plate_letter = $9, plate_left2 = $10,
                tracking_code = $11, discharge_date = $12, deliverer_id = $13,
                cost_load = $14, cost_unload = $15, cost_warehouse = $16,
                cost_tax = $17, cost_loading_fee = $18, cost_return_freight = $19,
                cost_misc = $20, cost_misc_desc = $21,
                payment_by = $22, payment_amount = $23, payment_source_id = $24, payment_source_type = $25,
                updated_at = NOW()
            WHERE id = $26 AND member_id = $27;
        `;

        await client.query(updateHeaderSql, [
            newStatus, doc_date,
            b.owner_id || null,
            b.driver_name, b.driver_national_id, b.driver_phone,
            b.plate?.right2 || b.plate_iran_right, b.plate?.middle3 || b.plate_mid3, b.plate?.letter || b.plate_letter, b.plate?.left2 || b.plate_left2,
            b.tracking_code, toYMD(b.discharge_date), (b.deliverer_id && isUUID(b.deliverer_id)) ? b.deliverer_id : null,
            toNum(b.cost_load || b.costs?.loadCost), toNum(b.cost_unload || b.costs?.unloadCost), toNum(b.cost_warehouse || b.costs?.warehouseCost),
            toNum(b.cost_tax || b.costs?.tax), toNum(b.cost_loading_fee || b.costs?.loadingFee), toNum(b.cost_return_freight || b.costs?.returnFreight),
            toNum(b.cost_misc || b.costs?.miscCost), b.cost_misc_desc || b.costs?.miscDescription,
            b.payment_by, toNum(b.payment_amount || b.payment?.info?.amount), b.payment_source_id, b.payment_source_type,
            receiptId, member_id
        ]);

        // حذف آیتم‌های قبلی و تراکنش‌های موجودی مرتبط
        if (oldStatus === "draft") {
            await client.query("DELETE FROM public.receipt_items WHERE receipt_id = $1", [receiptId]);
        }

        // اگر از draft به final تبدیل شده، تراکنش‌های قبلی رو پاک کن
        if (oldStatus === "draft" && newStatus === "final") {
            await client.query("DELETE FROM public.inventory_transactions WHERE ref_receipt_id = $1", [receiptId]);
        }

        // درج آیتم‌های جدید
        const items = Array.isArray(b.items) ? b.items : [];
        for (const item of items) {
            if (!item.product_id || !isUUID(item.product_id)) continue;

            const qty = toNum(item.qty || item.count);
            const wFull = toNum(item.weights_full);
            const wEmpty = toNum(item.weights_empty);
            const wNet = wFull - wEmpty;

            const itemSql = `
                INSERT INTO public.receipt_items (
                    receipt_id, owner_id, member_id, product_id,
                    count, weights_full, weights_empty, weights_net, weights_origin, weights_diff,
                    production_type, is_used, is_defective,
                    dim_length, dim_width, dim_thickness,
                    heat_number, bundle_no, brand, order_no, depo_location, description_notes,
                    row_code, parent_row,
                    created_at, updated_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, NOW(), NOW()
                ) RETURNING id;
            `;

            const itemRes = await client.query(itemSql, [
                receiptId, b.owner_id, member_id, item.product_id,
                qty, wFull, wEmpty, wNet, toNum(item.weights_origin), toNum(item.weights_diff),
                item.production_type || "domestic", item.is_used === true, item.is_defective === true,
                toNum(item.dim_length), toNum(item.dim_width), toNum(item.dim_thickness),
                item.heat_number, item.bundle_no, item.brand, item.order_no, item.depo_location, item.description_notes,
                item.row_code || "", item.parent_row || ""
            ]);

            const newItemId = itemRes.rows[0].id;

            // فقط در حالت final تراکنش موجودی بزن
            if (newStatus === "final") {
                const batchNo = item.row_code || item.bundle_no || item.heat_number || "";
                await client.query(`
                    INSERT INTO public.inventory_transactions (
                        type, transaction_type, ref_receipt_id, reference_id,
                        product_id, owner_id, member_id,
                        qty, weight, qty_real, weight_real, qty_available, weight_available,
                        batch_no, transaction_date, created_at, updated_at
                    ) VALUES ('in', 'havaleh', $1, $2, $3, $4, $5, $6, $7, $6, $7, $6, $7, $8, $9, NOW(), NOW());
                `, [
                    receiptId, newItemId, item.product_id, b.owner_id, member_id,
                    qty, wNet, batchNo, doc_date
                ]);
            }
        }

        // حسابداری فقط وقتی نهایی میشه
        if (newStatus === "final" && oldStatus === "draft") {
            try {
                await generateReceiptAccounting(client, {
                    receiptId, receiptNo, memberId: member_id, ownerId: b.owner_id, docDate: doc_date,
                    loadCost: toNum(b.cost_load), unloadCost: toNum(b.cost_unload), warehouseCost: toNum(b.cost_warehouse),
                    tax: toNum(b.cost_tax), loadingFee: toNum(b.cost_loading_fee), returnFreight: toNum(b.cost_return_freight),
                    miscCost: toNum(b.cost_misc), paymentBy: b.payment_by || "customer"
                });
            } catch (accErr) {
                console.error("⚠️ Accounting Error:", accErr.message);
            }
        }

        await client.query("COMMIT");
        res.json({ success: true, data: { id: receiptId, receipt_no: receiptNo } });

    } catch (e) {
        await client.query("ROLLBACK");
        console.error("❌ PUT Receipt Error:", e);
        res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

module.exports = router;
