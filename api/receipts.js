const express = require("express");
const router = express.Router();
const { pool } = require("../supabaseAdmin");
const authMiddleware = require("./middleware/auth");
const { generateReceiptAccounting } = require("./accounting/accountingAuto"); // ✅ اضافه شد

// --- توابع کمکی ---
const isUUID = (str) => str && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

const toYMD = (v) => {
    if (!v) return null;
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
};

const toNum = (v, fallback = 0) => {
    if (v === null || v === undefined || v === "") return fallback;
    const n = Number(String(v).replace(/,/g, ""));
    return Number.isFinite(n) ? n : fallback;
};

// =====================================================================
// 1) GET /api/receipts
// =====================================================================
router.get("/", authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.id;
        const { limit = 50, offset = 0, search, status } = req.query;

        const params = [member_id];
        let idx = 2;
        let where = `WHERE r.member_id = $1`;

        if (search) {
            params.push(`%${search}%`);
            where += ` AND (r.driver_name ILIKE $${idx} OR r.tracking_code ILIKE $${idx})`;
            idx++;
        }
        if (status) {
            params.push(status);
            where += ` AND r.status = $${idx++}`;
        }

        const sql = `
            SELECT r.*, dt.name as doc_type_name, c.name as owner_name,
                (SELECT COUNT(*) FROM public.receipt_items ri WHERE ri.receipt_id = r.id) as items_count,
                (SELECT COALESCE(SUM(ri.weights_net),0) FROM public.receipt_items ri WHERE ri.receipt_id = r.id) as total_weight
            FROM public.receipts r
            LEFT JOIN public.document_types dt ON dt.id = r.doc_type_id
            LEFT JOIN public.customers c ON c.id = r.owner_id
            ${where}
            ORDER BY r.created_at DESC
            LIMIT $${idx} OFFSET $${idx + 1}
        `;

        params.push(parseInt(limit), parseInt(offset));
        const { rows } = await pool.query(sql, params);
        const countRes = await pool.query(`SELECT COUNT(*)::bigint as total FROM public.receipts r ${where}`, params.slice(0, idx - 1));

        res.json({ success: true, data: rows, total: Number(countRes.rows[0]?.total || 0) });
    } catch (e) {
        console.error("❌ GET /receipts Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// =====================================================================
// 2) GET /api/receipts/:id
// =====================================================================
router.get("/:id", authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const member_id = req.user.id;

        if (!isUUID(id)) return res.status(400).json({ success: false, error: "Invalid receipt id" });

        const headerSql = `
            SELECT r.*, dt.name as doc_type_name,
                json_build_object('id', c.id, 'name', c.name, 'mobile', c.mobile, 'national_id', c.national_id) as owner
            FROM public.receipts r
            LEFT JOIN public.document_types dt ON dt.id = r.doc_type_id
            LEFT JOIN public.customers c ON c.id = r.owner_id
            WHERE r.id = $1 AND r.member_id = $2
        `;
        const rRes = await pool.query(headerSql, [id, member_id]);
        if (!rRes.rows.length) return res.status(404).json({ success: false, error: "رسید یافت نشد" });
        const receipt = rRes.rows[0];

        const itemsSql = `
            SELECT ri.*, p.name as product_name, p.sku, p.unit_id as unit_id
            FROM public.receipt_items ri
            LEFT JOIN public.products p ON p.id = ri.product_id
            WHERE ri.receipt_id = $1
            ORDER BY ri.created_at ASC
        `;
        const iRes = await pool.query(itemsSql, [id]);
        receipt.items = iRes.rows;

        // ✅ واکشی سند حسابداری مرتبط
        const accRes = await pool.query(
            `SELECT id, doc_no, doc_date, status, doc_type FROM public.financial_documents
             WHERE reference_id = $1 AND reference_type = 'receipt' LIMIT 1`, [id]);
        receipt.accounting_doc = accRes.rows[0] || null;

        res.json({ success: true, data: receipt });
    } catch (e) {
        console.error("❌ GET /receipts/:id Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// =====================================================================
// 3) POST /api/receipts  (ثبت رسید)
// =====================================================================
router.post("/", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const member_id = req.user.id;
        const b = req.body || {};

        if (!b.owner_id || !isUUID(b.owner_id)) return res.status(400).json({ success: false, error: "مالک کالا الزامی است" });

        await client.query("BEGIN");

        let finalDocTypeId = b.doc_type_id;
        if (!finalDocTypeId || !isUUID(finalDocTypeId)) {
            const dtRes = await client.query(`SELECT id FROM public.document_types WHERE name ILIKE '%رسید%' LIMIT 1`);
            if (dtRes.rows.length > 0) finalDocTypeId = dtRes.rows[0].id;
            else throw new Error("نوع سند 'رسید' یافت نشد");
        }

        const doc_date = toYMD(b.doc_date) || toYMD(new Date());
        const plate = b.plate || {};
        const costs = b.costs || {};
        const payment = b.payment || {};
        const paymentInfo = payment.info || {};
        const maxRes = await client.query("SELECT COALESCE(MAX(receipt_no), 1000)::bigint as max_no FROM public.receipts");
        const nextNo = BigInt(maxRes.rows[0]?.max_no || 1000) + 1n;

        const insertSql = `
            INSERT INTO public.receipts (
                doc_type_id, receipt_no, member_id, owner_id, status, doc_date,
                driver_name, driver_national_id, driver_birth_date, driver_phone,
                plate_iran_right, plate_mid3, plate_letter, plate_left2,
                ref_type, ref_barnameh_number, ref_barnameh_date, ref_barnameh_tracking,
                ref_petteh_number, ref_havale_number, ref_production_number, tracking_code,
                discharge_date, deliverer_id,
                load_cost, unload_cost, warehouse_cost, tax, loading_fee, return_freight, misc_cost, misc_description,
                cost_load, cost_unload, cost_warehouse, cost_tax, cost_loading_fee, cost_return_freight, cost_misc, cost_misc_desc,
                payment_by, payment_amount, payment_source_id, payment_source_type,
                card_number, account_number, bank_name, payment_owner_name, payment_tracking_code,
                created_at, updated_at
            )
            VALUES (
                $1, $2, $3, $4, $5, $6,
                $7, $8, $9, $10,
                $11, $12, $13, $14,
                $15, $16, $17, $18, $19, $20, $21, $22,
                $23, $24,
                $25, $26, $27, $28, $29, $30, $31, $32,
                $25, $26, $27, $28, $29, $30, $31, $32,
                $33, $34, $35, $36, $37, $38, $39, $40, $41,
                NOW(), NOW()
            )
            RETURNING id, receipt_no
        `;

        const values = [
            finalDocTypeId, nextNo.toString(), member_id, b.owner_id, b.status || "draft", doc_date,
            b.driver_name, b.driver_national_id, toYMD(b.driver_birth_date), b.driver_phone,
            b.plate_iran_right || plate.right2, b.plate_mid3 || plate.middle3, b.plate_letter || plate.letter, b.plate_left2 || plate.left2,
            b.ref_type || "none", b.ref_barnameh_number, toYMD(b.ref_barnameh_date), b.ref_barnameh_tracking,
            b.ref_petteh_number, b.ref_havale_number, b.ref_production_number, b.tracking_code,
            toYMD(b.discharge_date), (b.deliverer_id && isUUID(b.deliverer_id)) ? b.deliverer_id : null,
            toNum(b.load_cost || b.cost_load || costs.loadCost), toNum(b.unload_cost || b.cost_unload || costs.unloadCost), toNum(b.warehouse_cost || b.cost_warehouse || costs.warehouseCost), toNum(b.tax || b.cost_tax || costs.tax), toNum(b.loading_fee || b.cost_loading_fee || costs.loadingFee), toNum(b.return_freight || b.cost_return_freight || costs.returnFreight), toNum(b.misc_cost || b.cost_misc || costs.miscCost), b.misc_description || b.cost_misc_desc || costs.miscDescription,
            b.payment_by || payment.paymentBy, toNum(b.payment_amount || paymentInfo.amount), (b.payment_source_id && isUUID(b.payment_source_id)) ? b.payment_source_id : null, b.payment_source_type || paymentInfo.source_type,
            b.card_number || paymentInfo.cardNumber, b.account_number || paymentInfo.accountNumber, b.bank_name || paymentInfo.bankName, b.payment_owner_name || paymentInfo.ownerName, b.payment_tracking_code || paymentInfo.trackingCode
        ];

        // هزینه‌های نرمالایز شده (برای استفاده در حسابداری)
        const normalizedCosts = {
            loadCost:      toNum(b.load_cost || b.cost_load || costs.loadCost),
            unloadCost:    toNum(b.unload_cost || b.cost_unload || costs.unloadCost),
            warehouseCost: toNum(b.warehouse_cost || b.cost_warehouse || costs.warehouseCost),
            tax:           toNum(b.tax || b.cost_tax || costs.tax),
            loadingFee:    toNum(b.loading_fee || b.cost_loading_fee || costs.loadingFee),
            returnFreight: toNum(b.return_freight || b.cost_return_freight || costs.returnFreight),
            miscCost:      toNum(b.misc_cost || b.cost_misc || costs.miscCost),
        };

        const ins = await client.query(insertSql, values);
        const newReceiptId = ins.rows[0].id;
        const newReceiptNo = ins.rows[0].receipt_no;

        // ثبت آیتم‌ها
        const items = Array.isArray(b.items) ? b.items : [];
        if (items.length > 0) {
            for (const item of items) {
                if (!item.product_id || !isUUID(item.product_id)) continue;

                const count = toNum(item.count, 0);
                const wFull = toNum(item.weights_full, 0);
                const wEmpty = toNum(item.weights_empty, 0);
                const wNet = wFull - wEmpty;

                await client.query(`
                    INSERT INTO public.receipt_items (
                        receipt_id, owner_id, member_id, product_id,
                        count, weights_full, weights_empty, weights_net, weights_origin, weights_diff,
                        production_type, is_used, is_defective,
                        dim_length, dim_width, dim_thickness,
                        heat_number, bundle_no, brand, order_no, depo_location, description_notes,
                        created_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, NOW())
                `, [
                    newReceiptId, b.owner_id, member_id, item.product_id,
                    count, wFull, wEmpty, wNet, toNum(item.weights_origin), toNum(item.weights_diff),
                    item.production_type || 'domestic', item.is_used === true, item.is_defective === true,
                    toNum(item.dim_length), toNum(item.dim_width), toNum(item.dim_thickness),
                    item.heat_number, item.bundle_no, item.brand, item.order_no, item.depo_location, item.description_notes
                ]);

                if (b.status !== 'draft') {
                    await client.query(`
                        INSERT INTO public.inventory_transactions (
                            type, ref_receipt_id, product_id, owner_id, member_id,
                            qty, weight, qty_real, weight_real, qty_available, weight_available,
                            transaction_date, created_at
                        ) VALUES ('in', $1, $2, $3, $4, $5, $6, $5, $6, $5, $6, NOW(), NOW())
                    `, [newReceiptId, item.product_id, b.owner_id, member_id, count, wNet]);
                }
            }
        }

        // ✅ صدور خودکار سند حسابداری (فقط وقتی نهایی باشه)
        let accountingResult = null;
        if ((b.status || "draft") === "final") {
            try {
                accountingResult = await generateReceiptAccounting(client, {
                    receiptId:         newReceiptId,
                    receiptNo:         newReceiptNo,
                    memberId:          member_id,
                    ownerId:           b.owner_id,
                    docDate:           doc_date,
                    paymentBy:         b.payment_by || payment.paymentBy || "customer",
                    paymentSourceId:   (b.payment_source_id && isUUID(b.payment_source_id)) ? b.payment_source_id : null,
                    paymentSourceType: b.payment_source_type || paymentInfo.source_type || null,
                    ...normalizedCosts,
                });
                if (accountingResult) {
                    console.log(`✅ سند حسابداری #${accountingResult.docNo} برای رسید ${newReceiptNo} صادر شد`);
                }
            } catch (accErr) {
                console.error("⚠️ خطا در صدور سند حسابداری:", accErr.message);
            }
        }

        await client.query("COMMIT");
        res.json({
            success: true,
            message: "رسید ثبت شد",
            data: {
                id: newReceiptId,
                receipt_no: newReceiptNo,
                accounting_doc: accountingResult
            }
        });

    } catch (e) {
        await client.query("ROLLBACK");
        console.error("❌ POST /receipts Error:", e);
        res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

// =====================================================================
// 4) PUT /api/receipts/:id  (ویرایش)
// =====================================================================
router.put("/:id", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        const member_id = req.user.id;
        const b = req.body || {};

        if (!isUUID(id)) return res.status(400).json({ success: false, error: "Invalid ID" });

        const check = await client.query("SELECT status, receipt_no FROM public.receipts WHERE id = $1", [id]);
        if (!check.rows.length) return res.status(404).json({ success: false, error: "یافت نشد" });
        if (check.rows[0].status === "final") return res.status(400).json({ success: false, error: "غیرقابل ویرایش" });

        const previousStatus = check.rows[0].status;
        const receiptNo = check.rows[0].receipt_no;

        let finalDocTypeId = b.doc_type_id;
        if (!finalDocTypeId || !isUUID(finalDocTypeId)) {
             const dtRes = await client.query(`SELECT id FROM public.document_types WHERE name ILIKE '%رسید%' LIMIT 1`);
             if (dtRes.rows.length > 0) finalDocTypeId = dtRes.rows[0].id;
             else throw new Error("نوع سند یافت نشد");
        }

        const plate = b.plate || {};
        const costs = b.costs || {};
        const payment = b.payment || {};
        const paymentInfo = payment.info || {};

        await client.query("BEGIN");

        const updateSql = `
            UPDATE public.receipts SET
                doc_type_id=$1, status=$2, doc_date=$3, owner_id=$4,
                driver_name=$5, driver_national_id=$6, driver_phone=$7, driver_birth_date=$8,
                plate_iran_right=$9, plate_mid3=$10, plate_letter=$11, plate_left2=$12,
                ref_type=$13, ref_barnameh_number=$14, ref_barnameh_date=$15, ref_barnameh_tracking=$16,
                ref_petteh_number=$17, ref_havale_number=$18, ref_production_number=$19, tracking_code=$20,
                discharge_date=$21, deliverer_id=$22,
                load_cost=$23, unload_cost=$24, warehouse_cost=$25, tax=$26, loading_fee=$27, return_freight=$28, misc_cost=$29, misc_description=$30,
                cost_load=$23, cost_unload=$24, cost_warehouse=$25, cost_tax=$26, cost_loading_fee=$27, cost_return_freight=$28, cost_misc=$29, cost_misc_desc=$30,
                payment_by=$31, payment_amount=$32, payment_source_id=$33, payment_source_type=$34,
                card_number=$35, account_number=$36, bank_name=$37, payment_owner_name=$38, payment_tracking_code=$39,
                updated_at=NOW()
            WHERE id=$40
        `;

        const values = [
            finalDocTypeId, b.status || "draft", toYMD(b.doc_date), b.owner_id,
            b.driver_name, b.driver_national_id, b.driver_phone, toYMD(b.driver_birth_date),
            b.plate_iran_right || plate.right2, b.plate_mid3 || plate.middle3, b.plate_letter || plate.letter, b.plate_left2 || plate.left2,
            b.ref_type || "none", b.ref_barnameh_number, toYMD(b.ref_barnameh_date), b.ref_barnameh_tracking,
            b.ref_petteh_number, b.ref_havale_number, b.ref_production_number, b.tracking_code,
            toYMD(b.discharge_date), (b.deliverer_id && isUUID(b.deliverer_id)) ? b.deliverer_id : null,
            toNum(b.load_cost || b.cost_load || costs.loadCost), toNum(b.unload_cost || b.cost_unload || costs.unloadCost), toNum(b.warehouse_cost || b.cost_warehouse || costs.warehouseCost), toNum(b.tax || b.cost_tax || costs.tax), toNum(b.loading_fee || b.cost_loading_fee || costs.loadingFee), toNum(b.return_freight || b.cost_return_freight || costs.returnFreight), toNum(b.misc_cost || b.cost_misc || costs.miscCost), b.misc_description || b.cost_misc_desc || costs.miscDescription,
            b.payment_by || payment.paymentBy, toNum(b.payment_amount || paymentInfo.amount), (b.payment_source_id && isUUID(b.payment_source_id)) ? b.payment_source_id : null, b.payment_source_type || paymentInfo.source_type,
            b.card_number || paymentInfo.cardNumber, b.account_number || paymentInfo.accountNumber, b.bank_name || paymentInfo.bankName, b.payment_owner_name || paymentInfo.ownerName, b.payment_tracking_code || paymentInfo.trackingCode,
            id
        ];

        // هزینه‌های نرمالایز شده
        const normalizedCosts = {
            loadCost:      toNum(b.load_cost || b.cost_load || costs.loadCost),
            unloadCost:    toNum(b.unload_cost || b.cost_unload || costs.unloadCost),
            warehouseCost: toNum(b.warehouse_cost || b.cost_warehouse || costs.warehouseCost),
            tax:           toNum(b.tax || b.cost_tax || costs.tax),
            loadingFee:    toNum(b.loading_fee || b.cost_loading_fee || costs.loadingFee),
            returnFreight: toNum(b.return_freight || b.cost_return_freight || costs.returnFreight),
            miscCost:      toNum(b.misc_cost || b.cost_misc || costs.miscCost),
        };

        await client.query(updateSql, values);

        await client.query("DELETE FROM public.receipt_items WHERE receipt_id = $1", [id]);
        await client.query("DELETE FROM public.inventory_transactions WHERE ref_receipt_id = $1", [id]);

        const items = Array.isArray(b.items) ? b.items : [];
        if (items.length > 0) {
            for (const item of items) {
                if (!item.product_id || !isUUID(item.product_id)) continue;

                const count = toNum(item.count, 0);
                const wFull = toNum(item.weights_full, 0);
                const wEmpty = toNum(item.weights_empty, 0);
                const wNet = wFull - wEmpty;

                await client.query(`
                    INSERT INTO public.receipt_items (
                        receipt_id, owner_id, member_id, product_id,
                        count, weights_full, weights_empty, weights_net, weights_origin, weights_diff,
                        production_type, is_used, is_defective,
                        dim_length, dim_width, dim_thickness,
                        heat_number, bundle_no, brand, order_no, depo_location, description_notes,
                        created_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, NOW())
                `, [
                    id, b.owner_id, member_id, item.product_id,
                    count, wFull, wEmpty, wNet, toNum(item.weights_origin), toNum(item.weights_diff),
                    item.production_type || 'domestic', item.is_used === true, item.is_defective === true,
                    toNum(item.dim_length), toNum(item.dim_width), toNum(item.dim_thickness),
                    item.heat_number, item.bundle_no, item.brand, item.order_no, item.depo_location, item.description_notes
                ]);

                if (b.status !== 'draft') {
                    await client.query(`
                        INSERT INTO public.inventory_transactions (
                            type, ref_receipt_id, product_id, owner_id, member_id,
                            qty, weight, qty_real, weight_real, qty_available, weight_available,
                            transaction_date, created_at
                        ) VALUES ('in', $1, $2, $3, $4, $5, $6, $5, $6, $5, $6, NOW(), NOW())
                    `, [id, item.product_id, b.owner_id, member_id, count, wNet]);
                }
            }
        }

        // ✅ صدور خودکار سند حسابداری (فقط وقتی از draft به final میره)
        let accountingResult = null;
        if ((b.status || "draft") === "final" && previousStatus !== "final") {
            try {
                accountingResult = await generateReceiptAccounting(client, {
                    receiptId:         id,
                    receiptNo:         receiptNo,
                    memberId:          member_id,
                    ownerId:           b.owner_id,
                    docDate:           toYMD(b.doc_date),
                    paymentBy:         b.payment_by || payment.paymentBy || "customer",
                    paymentSourceId:   (b.payment_source_id && isUUID(b.payment_source_id)) ? b.payment_source_id : null,
                    paymentSourceType: b.payment_source_type || paymentInfo.source_type || null,
                    ...normalizedCosts,
                });
                if (accountingResult) {
                    console.log(`✅ سند حسابداری #${accountingResult.docNo} برای رسید ${receiptNo} صادر شد`);
                }
            } catch (accErr) {
                console.error("⚠️ خطا در صدور سند حسابداری:", accErr.message);
            }
        }

        await client.query("COMMIT");
        res.json({
            success: true,
            message: "بروزرسانی شد",
            data: { id, receipt_no: receiptNo, accounting_doc: accountingResult }
        });

    } catch (e) {
        await client.query("ROLLBACK");
        console.error("❌ PUT /receipts/:id Error:", e);
        res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

// =====================================================================
// 5) GET /api/receipts/:id/accounting - مشاهده سند حسابداری رسید ✅ جدید
// =====================================================================
router.get("/:id/accounting", authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const member_id = req.user.id;
        if (!isUUID(id)) return res.status(400).json({ success: false, error: "Invalid ID" });

        const docRes = await pool.query(`
            SELECT * FROM public.financial_documents
            WHERE reference_id = $1 AND reference_type = 'receipt' AND member_id = $2
            ORDER BY created_at DESC LIMIT 1`, [id, member_id]);

        if (!docRes.rows.length) return res.status(404).json({ success: false, error: "سند یافت نشد" });
        const doc = docRes.rows[0];

        const entriesRes = await pool.query(`
            SELECT e.*,
                json_build_object('id', m.id, 'code', m.code, 'title', m.title) as moein,
                CASE WHEN t.id IS NOT NULL
                    THEN json_build_object('id', t.id, 'code', t.code, 'title', t.title, 'tafsili_type', t.tafsili_type)
                    ELSE NULL END as tafsili
            FROM public.financial_entries e
            LEFT JOIN public.accounting_moein m ON m.id = e.moein_id
            LEFT JOIN public.accounting_tafsili t ON t.id = e.tafsili_id
            WHERE e.doc_id = $1 ORDER BY e.created_at ASC`, [doc.id]);

        res.json({ success: true, data: { ...doc, entries: entriesRes.rows } });
    } catch (e) {
        console.error("❌ GET /receipts/:id/accounting Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;