// api/clearances.js
const express = require("express");
const { pool } = require("../supabaseAdmin");
const authMiddleware = require("./middleware/auth");

const router = express.Router();

function toNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

async function generateClearanceNo(memberId) {
    try {
        const res = await pool.query("SELECT count(*) as count FROM clearances WHERE member_id = $1", [memberId]);
        const count = parseInt(res.rows[0].count);
        return 10000 + (count + 1);
    } catch (err) {
        throw new Error("خطا در تولید شماره سند");
    }
}

/* ============================================================
   0) Owner Full Inventory - ALL products + ALL batches at once
   GET /clearances/owner-inventory/:ownerId
============================================================ */
router.get("/owner-inventory/:ownerId", authMiddleware, async (req, res) => {
    try {
        const owner_id = req.params.ownerId;

        const query = `
            SELECT
                t.product_id,
                p.name                     AS product_title,
                pc.name                    AS category_name,
                COALESCE(NULLIF(t.batch_no,''), 'بدون ردیف') AS batch_no,

                -- ورودی: همه تراکنش‌های type=in (رسید، حواله فرزند، ...)
                SUM(CASE WHEN t.type = 'in' THEN ABS(t.qty) ELSE 0 END)    AS in_qty,
                SUM(CASE WHEN t.type = 'in' THEN ABS(t.weight) ELSE 0 END) AS in_weight,

                -- خروجی: همه تراکنش‌های type=out (حواله، ترخیص، بارگیری، ...)
                SUM(CASE WHEN t.type = 'out' THEN ABS(t.qty) ELSE 0 END)    AS out_qty,
                SUM(CASE WHEN t.type = 'out' THEN ABS(t.weight) ELSE 0 END) AS out_weight,

                MIN(t.created_at) AS first_date
            FROM inventory_transactions t
            LEFT JOIN products p            ON p.id  = t.product_id
            LEFT JOIN product_categories pc ON pc.id = p.category_id
            WHERE t.owner_id = $1
              AND t.type IN ('in', 'out')
            GROUP BY t.product_id, p.name, pc.name,
                     COALESCE(NULLIF(t.batch_no,''), 'بدون ردیف')
            HAVING
                (SUM(CASE WHEN t.type = 'in' THEN ABS(t.qty) ELSE 0 END)
               - SUM(CASE WHEN t.type = 'out' THEN ABS(t.qty) ELSE 0 END)) > 0
            ORDER BY COALESCE(NULLIF(t.batch_no,''), 'بدون ردیف') ASC, p.name ASC
        `;

        const { rows } = await pool.query(query, [owner_id]);

        // --- find max child index per batch ---
        const childQuery = `
            SELECT DISTINCT batch_no
            FROM inventory_transactions
            WHERE owner_id = $1
              AND batch_no LIKE '%/%'
        `;
        const { rows: childRows } = await pool.query(childQuery, [owner_id]);

        // build map: parentBatch -> maxChildIndex
        const childMap = {};
        childRows.forEach(cr => {
            if (!cr.batch_no) return;
            const parts = cr.batch_no.split('/');
            if (parts.length < 2) return;
            const parent = parts.slice(0, -1).join('/');
            const num = parseInt(parts[parts.length - 1]);
            if (!isNaN(num)) {
                childMap[parent] = Math.max(childMap[parent] || 0, num);
            }
        });

        const result = rows.map(row => {
            const qtyAvail  = toNumber(row.in_qty)    - toNumber(row.out_qty);
            const weightAvail = toNumber(row.in_weight) - toNumber(row.out_weight);
            const batchNo = row.batch_no;
            const nextChild = (childMap[batchNo] || 0) + 1;

            return {
                product_id:       row.product_id,
                product_title:    row.product_title || "نامشخص",
                category_name:    row.category_name || "بدون دسته",
                batch_no:         batchNo,
                qty_available:    Math.max(0, qtyAvail),
                weight_available: Math.max(0, weightAvail),
                next_child_index: nextChild,
                first_date:       row.first_date
            };
        });

        res.json({ success: true, data: result });

    } catch (e) {
        console.error("❌ Owner Inventory Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   1) Owner Products Summary (with category)
============================================================ */
router.get("/owner-products/:ownerId", authMiddleware, async (req, res) => {
    try {
        const owner_id = req.params.ownerId; 
        const query = `
            SELECT 
                t.product_id,
                p.name as product_title,
                pc.name as category_name,
                -- منبع (Source): در دیتابیس havaleh است
                SUM(CASE WHEN t.transaction_type IN ('havaleh', 'allocation', 'remittance', 'order', 'حواله') THEN ABS(t.qty) ELSE 0 END) as total_in_qty,
                SUM(CASE WHEN t.transaction_type IN ('havaleh', 'allocation', 'remittance', 'order', 'حواله') THEN ABS(t.weight) ELSE 0 END) as total_in_weight,
                
                -- کسر (Deduction): در دیتابیس clearance/out است
                SUM(CASE WHEN t.type = 'out' OR t.transaction_type IN ('clearance', 'exit', 'loading') THEN ABS(t.qty) ELSE 0 END) as total_out_qty,
                SUM(CASE WHEN t.type = 'out' OR t.transaction_type IN ('clearance', 'exit', 'loading') THEN ABS(t.weight) ELSE 0 END) as total_out_weight
            FROM inventory_transactions t
            LEFT JOIN products p ON p.id = t.product_id
            LEFT JOIN product_categories pc ON pc.id = p.category_id
            WHERE t.owner_id = $1
            GROUP BY t.product_id, p.name, pc.name
            HAVING 
                (SUM(CASE WHEN t.transaction_type IN ('havaleh', 'allocation', 'remittance', 'order', 'حواله') THEN ABS(t.qty) ELSE 0 END) - 
                 SUM(CASE WHEN t.type = 'out' OR t.transaction_type IN ('clearance', 'exit', 'loading') THEN ABS(t.qty) ELSE 0 END)) > 0
        `;

        const { rows } = await pool.query(query, [owner_id]);

        const summary = rows.map(row => ({
            product_id: row.product_id,
            product_title: row.product_title || "نامشخص",
            category_name: row.category_name || "بدون دسته",
            total_qty_available: toNumber(row.total_in_qty) - toNumber(row.total_out_qty),
            total_weight_available: toNumber(row.total_in_weight) - toNumber(row.total_out_weight)
        }));

        res.json({ success: true, data: summary });

    } catch (e) {
        console.error("❌ Owner Products Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   1.5) Lookup Row/Batch by number for an owner
   GET /clearances/lookup-row/:ownerId?batch_no=100
============================================================ */
router.get("/lookup-row/:ownerId", authMiddleware, async (req, res) => {
    try {
        const owner_id = req.params.ownerId;
        const batch_no = req.query.batch_no;

        if (!batch_no) return res.status(400).json({ success: false, error: "batch_no الزامی است" });

        const query = `
            SELECT 
                t.product_id,
                p.name as product_title,
                pc.name as category_name,
                COALESCE(NULLIF(t.batch_no, ''), 'بدون ردیف') as batch_key,
                SUM(CASE WHEN t.transaction_type IN ('havaleh', 'allocation', 'remittance', 'order', 'حواله') THEN ABS(t.qty) ELSE 0 END) as total_in_qty,
                SUM(CASE WHEN t.transaction_type IN ('havaleh', 'allocation', 'remittance', 'order', 'حواله') THEN ABS(t.weight) ELSE 0 END) as total_in_weight,
                SUM(CASE WHEN t.type = 'out' OR t.transaction_type IN ('clearance', 'exit', 'loading') THEN ABS(t.qty) ELSE 0 END) as total_out_qty,
                SUM(CASE WHEN t.type = 'out' OR t.transaction_type IN ('clearance', 'exit', 'loading') THEN ABS(t.weight) ELSE 0 END) as total_out_weight
            FROM inventory_transactions t
            LEFT JOIN products p ON p.id = t.product_id
            LEFT JOIN product_categories pc ON pc.id = p.category_id
            WHERE t.owner_id = $1
              AND COALESCE(NULLIF(t.batch_no, ''), 'بدون ردیف') = $2
            GROUP BY t.product_id, p.name, pc.name, COALESCE(NULLIF(t.batch_no, ''), 'بدون ردیف')
        `;

        const { rows } = await pool.query(query, [owner_id, batch_no]);

        if (rows.length === 0) {
            return res.json({ success: true, data: null, message: "ردیفی یافت نشد" });
        }

        const row = rows[0];
        const qtyAvailable = toNumber(row.total_in_qty) - toNumber(row.total_out_qty);
        const weightAvailable = toNumber(row.total_in_weight) - toNumber(row.total_out_weight);

        // پیدا کردن بزرگترین شماره فرزند
        const childQuery = `
            SELECT COALESCE(NULLIF(batch_no, ''), '') as child_batch
            FROM inventory_transactions
            WHERE owner_id = $1
              AND batch_no LIKE $2
        `;
        const { rows: childRows } = await pool.query(childQuery, [owner_id, batch_no + '/%']);

        let maxChildIndex = 0;
        childRows.forEach(cr => {
            const parts = cr.child_batch.split('/');
            const lastNum = parseInt(parts[parts.length - 1]);
            if (!isNaN(lastNum) && lastNum > maxChildIndex) maxChildIndex = lastNum;
        });

        res.json({
            success: true,
            data: {
                product_id: row.product_id,
                product_title: row.product_title || "نامشخص",
                category_name: row.category_name || "بدون دسته",
                batch_no: row.batch_key,
                qty_available: Math.max(0, qtyAvailable),
                weight_available: Math.max(0, weightAvailable),
                next_child_index: maxChildIndex + 1
            }
        });

    } catch (e) {
        console.error("❌ Lookup Row Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   2) Batches (رفع ارور json || json با استفاده از jsonb)
============================================================ */
router.get("/batches", authMiddleware, async (req, res) => {
    try {
        const owner_id = req.query.owner_id;
        const product_id = req.query.product_id;

        if (!owner_id || !product_id) return res.status(400).json({ success: false, error: "Missing params" });

        const query = `
            WITH BatchSummary AS (
                SELECT 
                    COALESCE(NULLIF(t.batch_no, ''), 'بدون ردیف') as batch_key,
                    
                    -- 1. محاسبه منبع (DB: havaleh)
                    SUM(
                        CASE 
                            WHEN transaction_type IN ('havaleh', 'allocation', 'remittance', 'order', 'حواله') 
                            THEN ABS(qty)
                            ELSE 0 
                        END
                    ) as total_allowed_qty,

                    SUM(
                        CASE 
                            WHEN transaction_type IN ('havaleh', 'allocation', 'remittance', 'order', 'حواله') 
                            THEN ABS(weight)
                            ELSE 0 
                        END
                    ) as total_allowed_weight,
                    
                    -- 2. محاسبه کسر (DB: clearance/out)
                    SUM(
                        CASE 
                            WHEN type = 'out' OR transaction_type IN ('clearance', 'exit', 'loading')
                            AND (transaction_type IS NULL OR transaction_type NOT IN ('havaleh', 'allocation', 'remittance', 'order', 'حواله'))
                            THEN ABS(qty) 
                            ELSE 0 
                        END
                    ) as total_exit_qty,
                    
                    SUM(
                        CASE 
                             WHEN type = 'out' OR transaction_type IN ('clearance', 'exit', 'loading')
                             AND (transaction_type IS NULL OR transaction_type NOT IN ('havaleh', 'allocation', 'remittance', 'order', 'حواله'))
                            THEN ABS(weight) 
                            ELSE 0 
                        END
                    ) as total_exit_weight,

                    MIN(created_at) as first_date,

                    -- 3. ساخت تاریخچه با تغییر نام (Rename)
                    json_agg(
                        json_build_object(
                            'id', id,
                            'qty', qty,
                            'weight', weight,
                            'transaction_date', created_at,
                            'type', type,
                            'transaction_type', transaction_type,
                            'batch_no', COALESCE(NULLIF(batch_no, ''), 'بدون ردیف'),
                            'type_label', CASE 
                                            WHEN transaction_type IN ('havaleh', 'allocation', 'remittance', 'order', 'حواله') THEN 'رسید'
                                            WHEN type = 'out' OR transaction_type IN ('clearance', 'exit', 'loading') THEN 'حواله'
                                            ELSE 'نامشخص'
                                          END
                        ) ORDER BY created_at DESC
                    ) FILTER (
                        -- فقط خروجی‌ها در لیست بازشو باشند، چون رسید را تجمیع می‌کنیم
                        WHERE type = 'out' OR transaction_type IN ('clearance', 'exit', 'loading')
                    ) as exit_history

                FROM inventory_transactions
                WHERE owner_id = $1 AND product_id = $2
                
                -- فیلتر: فقط رکوردهای مرتبط
                AND (
                    transaction_type IN ('havaleh', 'allocation', 'remittance', 'order', 'حواله')
                    OR
                    (type = 'out' OR transaction_type IN ('clearance', 'exit', 'loading'))
                )

                GROUP BY COALESCE(NULLIF(batch_no, ''), 'بدون ردیف')
            )
            SELECT 
                batch_key as batch_no,
                (total_allowed_qty - total_exit_qty) as qty_available,
                (total_allowed_weight - total_exit_weight) as weight_available,
                first_date as transaction_date,
                
                -- 4. ساخت آرایه نهایی تاریخچه (اصلاح شده برای رفع ارور JSON)
                (
                    json_build_array(
                        json_build_object(
                            'id', 'sum-' || batch_key,
                            'qty', total_allowed_qty,
                            'weight', total_allowed_weight,
                            'transaction_date', first_date,
                            'type_label', 'رسید', 
                            'batch_no', batch_key,
                            'type', 'aggregated_in'
                        )
                    )::jsonb  -- <--- تبدیل به JSONB
                    ||
                    COALESCE(exit_history, '[]'::json)::jsonb -- <--- تبدیل به JSONB
                ) as history

            FROM BatchSummary
            WHERE (total_allowed_qty - total_exit_qty) > 0
            ORDER BY first_date ASC
        `;

        const { rows } = await pool.query(query, [owner_id, product_id]);

        const result = rows.map(row => ({
            batch_no: row.batch_no,
            qty_available: toNumber(row.qty_available),
            weight_available: toNumber(row.weight_available),
            transaction_date: row.transaction_date,
            history: row.history
        }));

        res.json({ success: true, data: result });

    } catch (e) {
        console.error("❌ Batch Grouping Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   3) CREATE Clearance
============================================================ */
router.post("/", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const member_id = req.user.member_id;

        const {
            customer_id, clearance_date, 
            receiver_person_name, receiver_person_national_id,
            driver_name, plate, description, items, 
            doc_type_id = '72b5831e-f37b-8c8b-c189-2e3538aff23a'
        } = req.body;

        if (!customer_id || !items || items.length === 0) {
            throw new Error("اطلاعات ناقص است");
        }

        const clearanceNo = await generateClearanceNo(member_id);

        let pRight='', pMid='', pLet='', pLeft='';
        const plateStr = (plate && typeof plate === 'object') ? plate.plate_number : plate;
        if (plateStr && typeof plateStr === 'string') {
            const parts = plateStr.split('-');
            pLeft = parts[0]||''; pMid = parts[1]||''; pLet = parts[2]||''; pRight = parts[3]||'';
        } else if (plate && typeof plate === 'object') {
             pRight = plate.right2; pMid = plate.middle3; pLet = plate.letter; pLeft = plate.left2;
        }

        const insertHeaderSql = `
            INSERT INTO clearances (
                doc_type_id, clearance_no, member_id, status, clearance_date, customer_id,
                receiver_person_name, receiver_person_national_id, driver_name,
                vehicle_plate_iran_right, vehicle_plate_mid3, vehicle_plate_letter, vehicle_plate_left2, description,
                created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW())
            RETURNING id
        `;
        const headerValues = [
            doc_type_id, clearanceNo, member_id, 'final', clearance_date || new Date(), customer_id,
            receiver_person_name, receiver_person_national_id, driver_name,
            pRight, pMid, pLet, pLeft, description
        ];
        
        const headerRes = await client.query(insertHeaderSql, headerValues);
        const clearanceId = headerRes.rows[0].id;

        const txDate = clearance_date || new Date();

        for (const item of items) {
            const qty = toNumber(item.qty);
            const weight = toNumber(item.weight);
            const prodId = item.product_id;
            const parentBatch = item.parent_batch_no || '';
            const newBatch = item.new_batch_no || '';

            // 1) ثبت در clearance_items
            const ciRes = await client.query(`
                INSERT INTO clearance_items (
                    clearance_id, product_id, owner_id, qty, weight,
                    parent_batch_no, new_batch_no, manual_ref_id, attachment_url, description, status,
                    created_at, updated_at, batch_no
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW(), $12)
                RETURNING id
            `, [
                clearanceId, prodId, customer_id, qty, weight,
                parentBatch, newBatch,
                item.manual_ref_id, item.attachment_url, item.description, 'issued',
                newBatch
            ]);
            const clearanceItemId = ciRes.rows[0].id;

            // 2) تراکنش خروج (out) از ردیف مادر — کم شدن موجودی مادر
            await client.query(`
                INSERT INTO inventory_transactions (
                    type, transaction_type, ref_clearance_id, reference_id,
                    product_id, owner_id, member_id,
                    qty, weight, qty_real, weight_real, qty_available, weight_available,
                    batch_no, transaction_date, created_at, updated_at
                ) VALUES (
                    'out', 'clearance', $1, $2, $3, $4, $5,
                    $6, $7, $6, $7, $6, $7,
                    $8, $9, NOW(), NOW()
                )
            `, [
                clearanceId, clearanceItemId, prodId, customer_id, member_id,
                qty, weight,
                parentBatch, txDate
            ]);

            // 3) تراکنش ورود (in) برای ردیف فرزند — ایجاد موجودی جدید برای فرزند
            //    فقط اگر ردیف فرزند "بدون ردیف" نباشد
            if (newBatch && newBatch !== 'بدون ردیف') {
                await client.query(`
                    INSERT INTO inventory_transactions (
                        type, transaction_type, ref_clearance_id, reference_id,
                        product_id, owner_id, member_id,
                        qty, weight, qty_real, weight_real, qty_available, weight_available,
                        batch_no, transaction_date, created_at, updated_at
                    ) VALUES (
                        'in', 'clearance', $1, $2, $3, $4, $5,
                        $6, $7, $6, $7, $6, $7,
                        $8, $9, NOW(), NOW()
                    )
                `, [
                    clearanceId, clearanceItemId, prodId, customer_id, member_id,
                    qty, weight,
                    newBatch, txDate
                ]);
            }
        }

        await client.query('COMMIT');
        res.json({ success: true, clearance_no: clearanceNo, id: clearanceId, message: "ثبت شد" });

    } catch (e) {
        await client.query('ROLLBACK');
        console.error("❌ Create Error:", e);
        res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

/* ============================================================
   4) REPORT
============================================================ */
router.get("/report", authMiddleware, async (req, res) => {
    try {
        const query = `
            SELECT 
                c.*, 
                cust.name as customer_name,
                cust.description as customer_desc,
                EXISTS (
                    SELECT 1 FROM loading_order_items li
                    JOIN clearance_items ci ON ci.id = li.clearance_item_id
                    WHERE ci.clearance_id = c.id
                ) AS has_loading
            FROM clearances c
            LEFT JOIN customers cust ON cust.id = c.customer_id
            ORDER BY c.clearance_date DESC
            LIMIT 500
        `;
        const { rows: clearances } = await pool.query(query);
        if (clearances.length === 0) return res.json({ success: true, data: [] });

        const ids = clearances.map(c => c.id);
        const itemsQuery = `
            SELECT ci.*, p.name as product_name, c.clearance_date,
                (SELECT COALESCE(SUM(CASE WHEN it.type = 'in' THEN it.qty ELSE 0 END) - 
                        SUM(CASE WHEN it.type = 'out' OR it.transaction_type IN ('clearance', 'exit', 'loading') THEN ABS(it.qty) ELSE 0 END), 0)
                 FROM inventory_transactions it
                 WHERE it.owner_id = ci.owner_id AND it.product_id = ci.product_id AND COALESCE(it.batch_no, '') = COALESCE(ci.parent_batch_no, '')
                ) as current_stock
            FROM clearance_items ci
            LEFT JOIN products p ON p.id = ci.product_id
            LEFT JOIN clearances c ON c.id = ci.clearance_id
            WHERE ci.clearance_id = ANY($1::uuid[])
        `;
        const { rows: items } = await pool.query(itemsQuery, [ids]);
        const itemsByClearance = {};
        items.forEach(it => {
            if (!itemsByClearance[it.clearance_id]) itemsByClearance[it.clearance_id] = [];
            itemsByClearance[it.clearance_id].push({
                ...it,
                product: { id: it.product_id, title: it.product_name },
                available_stock: toNumber(it.current_stock)
            });
        });
        const output = clearances.map(c => ({
            ...c,
            customer: { id: c.customer_id, name: c.customer_name || "بدون نام" },
            items: itemsByClearance[c.id] || []
        }));
        res.json({ success: true, data: output });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   5) GET ITEMS
============================================================ */
router.get("/:clearanceId/items", authMiddleware, async (req, res) => {
    try {
        const { clearanceId } = req.params;
        const query = `
            SELECT ci.*, p.name as product_name, c.clearance_date,
                (SELECT COALESCE(SUM(CASE WHEN it.type = 'in' THEN it.qty ELSE 0 END) - 
                        SUM(CASE WHEN it.type = 'out' OR it.transaction_type IN ('clearance', 'exit', 'loading') THEN ABS(it.qty) ELSE 0 END), 0)
                 FROM inventory_transactions it
                 WHERE it.owner_id = ci.owner_id AND it.product_id = ci.product_id AND COALESCE(it.batch_no, '') = COALESCE(ci.parent_batch_no, '')
                ) as current_stock
            FROM clearance_items ci
            LEFT JOIN products p ON p.id = ci.product_id
            LEFT JOIN clearances c ON c.id = ci.clearance_id
            WHERE ci.clearance_id = $1 ORDER BY ci.created_at
        `;
        const { rows } = await pool.query(query, [clearanceId]);
        const items = rows.map(row => ({
            ...row,
            product: { id: row.product_id, title: row.product_name },
            available_stock: toNumber(row.current_stock)
        }));
        res.json({ success: true, data: items });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   6) DELETE /api/clearances/:id - حذف حواله ترخیص
   فقط اگر هنوز بارگیری نشده باشد
============================================================ */
router.delete("/:id", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const clearanceId = req.params.id;
        const member_id = req.user.member_id;

        await client.query('BEGIN');

        // بررسی وجود سند
        const { rows: clRows } = await client.query(
            `SELECT id FROM clearances WHERE id = $1 AND member_id = $2`,
            [clearanceId, member_id]
        );
        if (!clRows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: "سند یافت نشد" });
        }

        // بررسی اینکه آیا بارگیری شده یا نه
        const { rows: loadedItems } = await client.query(
            `SELECT li.id FROM loading_order_items li
             JOIN clearance_items ci ON ci.id = li.clearance_item_id
             WHERE ci.clearance_id = $1 LIMIT 1`,
            [clearanceId]
        );
        if (loadedItems.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: "این حواله قبلاً بارگیری شده و قابل حذف نیست" });
        }

        // حذف تراکنش‌های مرتبط
        await client.query(
            `DELETE FROM inventory_transactions WHERE ref_clearance_id = $1`,
            [clearanceId]
        );

        // حذف آیتم‌ها
        await client.query(
            `DELETE FROM clearance_items WHERE clearance_id = $1`,
            [clearanceId]
        );

        // حذف هدر
        await client.query(
            `DELETE FROM clearances WHERE id = $1`,
            [clearanceId]
        );

        await client.query('COMMIT');
        return res.json({ success: true, message: "حواله با موفقیت حذف شد" });

    } catch (e) {
        await client.query('ROLLBACK');
        console.error("❌ DELETE /clearances/:id error:", e.message);
        return res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

module.exports = router;