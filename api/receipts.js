const express = require("express");
const router = express.Router();
const { pool } = require("../supabaseAdmin");
const authMiddleware = require("./middleware/auth");
const { generateReceiptAccounting } = require("./accounting/accountingAuto");

const isUUID = (str) => str && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
const toYMD = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); };
const toNum = (v, fallback = 0) => { if (v === null || v === undefined || v === "") return fallback; const n = Number(String(v).replace(/,/g, "")); return Number.isFinite(n) ? n : fallback; };
const toInt = (v, fallback) => { const n = Number.parseInt(String(v ?? ""), 10); return Number.isFinite(n) && n >= 0 ? n : fallback; };

const buildListFilters = (query, values) => {
    const where = ["r.member_id = $1"];
    if (query.status) { values.push(String(query.status).trim()); where.push(`r.status = $${values.length}`); }
    if (query.owner_id && isUUID(query.owner_id)) { values.push(query.owner_id); where.push(`r.owner_id = $${values.length}`); }
    const dateFrom = toYMD(query.date_from);
    if (dateFrom) { values.push(dateFrom); where.push(`r.doc_date >= $${values.length}`); }
    const dateTo = toYMD(query.date_to);
    if (dateTo) { values.push(dateTo); where.push(`r.doc_date <= $${values.length}`); }
    const search = String(query.search || "").trim();
    if (search) {
        values.push(`%${search}%`);
        const idx = values.length;
        where.push(`(CAST(r.receipt_no AS text) ILIKE $${idx} OR COALESCE(r.driver_name,'') ILIKE $${idx} OR COALESCE(c.name,'') ILIKE $${idx} OR COALESCE(r.tracking_code,'') ILIKE $${idx} OR COALESCE(r.payment_by,'') ILIKE $${idx})`);
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
            SELECT r.*, c.name AS owner_name,
                json_build_object('id',c.id,'name',c.name,'mobile',c.mobile,'national_id',c.national_id,'birth_date',c.birth_or_register_date,'tafsili_id',c.tafsili_id) AS owner,
                COALESCE(ri_stats.items_count,0)::int AS items_count,
                COALESCE(ri_stats.total_weight,0)::float8 AS total_weight
            FROM public.receipts r
            LEFT JOIN public.customers c ON c.id = r.owner_id
            LEFT JOIN LATERAL (SELECT COUNT(*) AS items_count, COALESCE(SUM(COALESCE(ri.weights_net,0)),0) AS total_weight FROM public.receipt_items ri WHERE ri.receipt_id = r.id) ri_stats ON TRUE
            WHERE ${whereSql}
            ORDER BY r.doc_date DESC NULLS LAST, r.created_at DESC
            LIMIT $${values.length + 1} OFFSET $${values.length + 2};`;

        const countSql = `SELECT COUNT(*)::int AS total FROM public.receipts r LEFT JOIN public.customers c ON c.id = r.owner_id WHERE ${whereSql};`;
        const [listRes, countRes] = await Promise.all([pool.query(listSql, [...values, limit, offset]), pool.query(countSql, values)]);
        res.json({ success: true, data: { items: listRes.rows, total: countRes.rows[0]?.total || 0, limit, offset } });
    } catch (e) {
        console.error("GET Receipts Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
};

router.get("/", authMiddleware, getReceiptsListHandler);
router.get("/list", authMiddleware, getReceiptsListHandler);

router.get("/:id", authMiddleware, async (req, res) => {
    try {
        const memberId = req.user.member_id || req.user.id;
        const { id } = req.params;
        if (!isUUID(id)) return res.status(400).json({ success: false, error: "شناسه رسید نامعتبر است" });

        const headerSql = `
            SELECT r.*, c.name AS owner_name,
                json_build_object('id',c.id,'name',c.name,'mobile',c.mobile,'national_id',c.national_id,'birth_date',c.birth_or_register_date,'tafsili_id',c.tafsili_id) AS owner
            FROM public.receipts r LEFT JOIN public.customers c ON c.id = r.owner_id
            WHERE r.id = $1 AND r.member_id = $2 LIMIT 1;`;
        const headerRes = await pool.query(headerSql, [id, memberId]);
        if (headerRes.rows.length === 0) return res.status(404).json({ success: false, error: "رسید یافت نشد" });

        const itemsSql = `SELECT * FROM public.receipt_items WHERE receipt_id = $1 ORDER BY created_at ASC, id ASC;`;
        const itemsRes = await pool.query(itemsSql, [id]);
        res.json({ success: true, data: { ...headerRes.rows[0], items: itemsRes.rows } });
    } catch (e) {
        console.error("GET Receipt By ID Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post("/", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const member_id = req.user.member_id;
        const b = req.body || {};
        if (!b.owner_id || !isUUID(b.owner_id)) return res.status(400).json({ success: false, error: "مالک کالا الزامی است" });

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
                driver_name, driver_national_id, driver_phone, driver_birth_date,
                plate_iran_right, plate_mid3, plate_letter, plate_left2,
                tracking_code, discharge_date, deliverer_id,
                ref_type, ref_barnameh_number, ref_barnameh_date, ref_barnameh_tracking,
                ref_petteh_number, ref_havale_number, ref_production_number,
                cost_load, cost_unload, cost_warehouse, cost_tax, cost_loading_fee, cost_return_freight, cost_misc, cost_misc_desc,
                payment_by, payment_amount, payment_source_id, payment_source_type, payment_tracking_code,
                card_number, account_number, bank_name, payment_owner_name,
                created_at, updated_at
            ) VALUES (
                $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                $18,$19,$20,$21,$22,$23,$24,
                $25,$26,$27,$28,$29,$30,$31,$32,
                $33,$34,$35,$36,$37,$38,$39,$40,$41,
                NOW(), NOW()
            ) RETURNING id;`;

        const headerRes = await client.query(insertHeaderSql, [
            finalDocTypeId, nextNo, member_id, b.owner_id, b.status || "final", doc_date,
            b.driver_name, b.driver_national_id, b.driver_phone, toYMD(b.driver_birth_date),
            b.plate_iran_right || b.plate?.right2, b.plate_mid3 || b.plate?.middle3, b.plate_letter || b.plate?.letter, b.plate_left2 || b.plate?.left2,
            b.tracking_code, toYMD(b.discharge_date), (b.deliverer_id && isUUID(b.deliverer_id)) ? b.deliverer_id : null,
            b.ref_type || "none", b.ref_barnameh_number || "", toYMD(b.ref_barnameh_date), b.ref_barnameh_tracking || "",
            b.ref_petteh_number || "", b.ref_havale_number || "", b.ref_production_number || "",
            toNum(b.cost_load), toNum(b.cost_unload), toNum(b.cost_warehouse),
            toNum(b.cost_tax), toNum(b.cost_loading_fee), toNum(b.cost_return_freight),
            toNum(b.cost_misc), b.cost_misc_desc || "",
            b.payment_by, toNum(b.payment_amount), b.payment_source_id || null, b.payment_source_type || null, b.payment_tracking_code || "",
            b.card_number || "", b.account_number || "", b.bank_name || "", b.payment_owner_name || ""
        ]);

        const newReceiptId = headerRes.rows[0].id;

        const items = Array.isArray(b.items) ? b.items : [];

        // Validate parent_row uniqueness (each parent_row can only belong to one product+owner combo)
        for (const item of items) {
            const pr = (item.parent_row || "").trim();
            if (!pr || !item.product_id) continue;
            const dupCheck = await client.query(
                `SELECT ri.id, ri.product_id, ri.owner_id FROM public.receipt_items ri
                 JOIN public.receipts r ON r.id = ri.receipt_id
                 WHERE ri.parent_row = $1 AND r.member_id = $2
                 AND (ri.product_id != $3 OR ri.owner_id != $4) LIMIT 1`,
                [pr, member_id, item.product_id, b.owner_id]
            );
            if (dupCheck.rows.length > 0) {
                await client.query("ROLLBACK");
                return res.status(400).json({ success: false, error: `ردیف حواله "${pr}" قبلاً برای محصول/مشتری دیگری ثبت شده است` });
            }
        }

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
                    row_code, parent_row, created_at, updated_at
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,NOW(),NOW()) RETURNING id;`;

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
                const batchNo = item.row_code || item.bundle_no || item.heat_number || "";
                await client.query(`
                    INSERT INTO public.inventory_transactions (
                        type, transaction_type, ref_receipt_id, reference_id,
                        product_id, owner_id, member_id,
                        qty, weight, qty_real, weight_real, qty_available, weight_available,
                        batch_no, transaction_date, created_at, updated_at
                    ) VALUES ('in','havaleh',$1,$2,$3,$4,$5,$6,$7,$6,$7,$6,$7,$8,$9,NOW(),NOW());`,
                    [newReceiptId, newItemId, item.product_id, b.owner_id, member_id, qty, wNet, batchNo, doc_date]);
            }
        }

        if (b.status === "final") {
            try {
                await generateReceiptAccounting(client, {
                    receiptId: newReceiptId, receiptNo: nextNo, memberId: member_id, ownerId: b.owner_id, docDate: doc_date,
                    loadCost: toNum(b.cost_load), unloadCost: toNum(b.cost_unload), warehouseCost: toNum(b.cost_warehouse),
                    tax: toNum(b.cost_tax), loadingFee: toNum(b.cost_loading_fee), returnFreight: toNum(b.cost_return_freight),
                    miscCost: toNum(b.cost_misc), paymentBy: b.payment_by || "customer",
                    paymentSourceId: b.payment_source_id || null,
                    paymentSourceType: b.payment_source_type || null,
                });
            } catch (accErr) {
                console.error("Accounting Error:", accErr.message);
            }
        }

        await client.query("COMMIT");
        res.json({ success: true, data: { id: newReceiptId, receipt_no: nextNo } });
    } catch (e) {
        await client.query("ROLLBACK");
        console.error("POST Receipt Error:", e);
        res.status(500).json({ success: false, error: e.message });
    } finally { client.release(); }
});

router.put("/:id", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const member_id = req.user.member_id;
        const receiptId = req.params.id;
        const b = req.body || {};
        if (!isUUID(receiptId)) return res.status(400).json({ success: false, error: "شناسه رسید نامعتبر است" });

        await client.query("BEGIN");
        const existing = await client.query("SELECT id, status, receipt_no FROM public.receipts WHERE id=$1 AND member_id=$2", [receiptId, member_id]);
        if (existing.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, error: "رسید یافت نشد" }); }

        const oldStatus = existing.rows[0].status;
        const receiptNo = existing.rows[0].receipt_no;
        const newStatus = b.status || oldStatus;
        const doc_date = toYMD(b.doc_date) || toYMD(new Date());

        const updateHeaderSql = `
            UPDATE public.receipts SET
                status=$1, doc_date=$2, owner_id=$3,
                driver_name=$4, driver_national_id=$5, driver_phone=$6, driver_birth_date=$7,
                plate_iran_right=$8, plate_mid3=$9, plate_letter=$10, plate_left2=$11,
                tracking_code=$12, discharge_date=$13, deliverer_id=$14,
                ref_type=$15, ref_barnameh_number=$16, ref_barnameh_date=$17, ref_barnameh_tracking=$18,
                ref_petteh_number=$19, ref_havale_number=$20, ref_production_number=$21,
                cost_load=$22, cost_unload=$23, cost_warehouse=$24, cost_tax=$25,
                cost_loading_fee=$26, cost_return_freight=$27, cost_misc=$28, cost_misc_desc=$29,
                payment_by=$30, payment_amount=$31, payment_source_id=$32, payment_source_type=$33, payment_tracking_code=$34,
                card_number=$35, account_number=$36, bank_name=$37, payment_owner_name=$38,
                updated_at=NOW()
            WHERE id=$39 AND member_id=$40;`;

        await client.query(updateHeaderSql, [
            newStatus, doc_date, b.owner_id || null,
            b.driver_name, b.driver_national_id, b.driver_phone, toYMD(b.driver_birth_date),
            b.plate_iran_right || b.plate?.right2, b.plate_mid3 || b.plate?.middle3, b.plate_letter || b.plate?.letter, b.plate_left2 || b.plate?.left2,
            b.tracking_code, toYMD(b.discharge_date), (b.deliverer_id && isUUID(b.deliverer_id)) ? b.deliverer_id : null,
            b.ref_type || "none", b.ref_barnameh_number || "", toYMD(b.ref_barnameh_date), b.ref_barnameh_tracking || "",
            b.ref_petteh_number || "", b.ref_havale_number || "", b.ref_production_number || "",
            toNum(b.cost_load), toNum(b.cost_unload), toNum(b.cost_warehouse), toNum(b.cost_tax),
            toNum(b.cost_loading_fee), toNum(b.cost_return_freight), toNum(b.cost_misc), b.cost_misc_desc || "",
            b.payment_by, toNum(b.payment_amount), b.payment_source_id || null, b.payment_source_type || null, b.payment_tracking_code || "",
            b.card_number || "", b.account_number || "", b.bank_name || "", b.payment_owner_name || "",
            receiptId, member_id
        ]);

        const items = Array.isArray(b.items) ? b.items : [];

        // Validate parent_row uniqueness (exclude current receipt's items)
        for (const item of items) {
            const pr = (item.parent_row || "").trim();
            if (!pr || !item.product_id) continue;
            const dupCheck = await client.query(
                `SELECT ri.id, ri.product_id, ri.owner_id FROM public.receipt_items ri
                 JOIN public.receipts r ON r.id = ri.receipt_id
                 WHERE ri.parent_row = $1 AND r.member_id = $2 AND ri.receipt_id != $3
                 AND (ri.product_id != $4 OR ri.owner_id != $5) LIMIT 1`,
                [pr, member_id, receiptId, item.product_id, b.owner_id]
            );
            if (dupCheck.rows.length > 0) {
                await client.query("ROLLBACK");
                return res.status(400).json({ success: false, error: `ردیف حواله "${pr}" قبلاً برای محصول/مشتری دیگری ثبت شده است` });
            }
        }

        if (oldStatus === "draft") {
            await client.query("DELETE FROM public.receipt_items WHERE receipt_id=$1", [receiptId]);
        }
        if (oldStatus === "draft" && newStatus === "final") {
            await client.query("DELETE FROM public.inventory_transactions WHERE ref_receipt_id=$1", [receiptId]);
        }

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
                    row_code, parent_row, created_at, updated_at
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,NOW(),NOW()) RETURNING id;`;

            const itemRes = await client.query(itemSql, [
                receiptId, b.owner_id, member_id, item.product_id,
                qty, wFull, wEmpty, wNet, toNum(item.weights_origin), toNum(item.weights_diff),
                item.production_type || "domestic", item.is_used === true, item.is_defective === true,
                toNum(item.dim_length), toNum(item.dim_width), toNum(item.dim_thickness),
                item.heat_number, item.bundle_no, item.brand, item.order_no, item.depo_location, item.description_notes,
                item.row_code || "", item.parent_row || ""
            ]);
            const newItemId = itemRes.rows[0].id;
            if (newStatus === "final") {
                const batchNo = item.row_code || item.bundle_no || item.heat_number || "";
                await client.query(`
                    INSERT INTO public.inventory_transactions (
                        type, transaction_type, ref_receipt_id, reference_id,
                        product_id, owner_id, member_id,
                        qty, weight, qty_real, weight_real, qty_available, weight_available,
                        batch_no, transaction_date, created_at, updated_at
                    ) VALUES ('in','havaleh',$1,$2,$3,$4,$5,$6,$7,$6,$7,$6,$7,$8,$9,NOW(),NOW());`,
                    [receiptId, newItemId, item.product_id, b.owner_id, member_id, qty, wNet, batchNo, doc_date]);
            }
        }

        if (newStatus === "final" && oldStatus === "draft") {
            try {
                await generateReceiptAccounting(client, {
                    receiptId, receiptNo, memberId: member_id, ownerId: b.owner_id, docDate: doc_date,
                    loadCost: toNum(b.cost_load), unloadCost: toNum(b.cost_unload), warehouseCost: toNum(b.cost_warehouse),
                    tax: toNum(b.cost_tax), loadingFee: toNum(b.cost_loading_fee), returnFreight: toNum(b.cost_return_freight),
                    miscCost: toNum(b.cost_misc), paymentBy: b.payment_by || "customer",
                    paymentSourceId: b.payment_source_id || null,
                    paymentSourceType: b.payment_source_type || null,
                });
            } catch (accErr) {
                console.error("Accounting Error:", accErr.message);
            }
        }

        await client.query("COMMIT");
        res.json({ success: true, data: { id: receiptId, receipt_no: receiptNo } });
    } catch (e) {
        await client.query("ROLLBACK");
        console.error("PUT Receipt Error:", e);
        res.status(500).json({ success: false, error: e.message });
    } finally { client.release(); }
});

module.exports = router;
