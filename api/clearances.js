// api/clearances.js
const express = require("express");
const { pool } = require("../supabaseAdmin");
const authMiddleware = require("./middleware/auth");

const router = express.Router();

/* ============================================================
   Helpers
============================================================ */
function toNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

// Helper: دریافت ID ممبر
async function getMemberId(userId) {
    if (!userId) return null;
    try {
        const res = await pool.query("SELECT id FROM members WHERE auth_user_id = $1", [userId]);
        if (res.rows.length === 0) {
            const fallback = await pool.query("SELECT id FROM members LIMIT 1");
            return fallback.rows.length > 0 ? fallback.rows[0].id : null;
        }
        return res.rows[0].id;
    } catch (err) {
        console.error("Error getting member id:", err);
        return null;
    }
}

// Helper: تولید شماره سند ترخیص
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
   1) Owner Products Summary - با محاسبه صحیح موجودی
   فرمول: رسید - (خروجی + حواله) = موجودی
============================================================ */
router.get("/owner-products/:ownerId", authMiddleware, async (req, res) => {
    try {
        const owner_id = req.params.ownerId; 

        const query = `
            SELECT 
                t.product_id,
                p.name as product_title,
                -- ورودی
                SUM(CASE WHEN t.type = 'in' THEN t.qty ELSE 0 END) as total_in_qty,
                SUM(CASE WHEN t.type = 'in' THEN t.weight ELSE 0 END) as total_in_weight,
                -- خروجی (شامل clearance, exit, loading)
                SUM(
                    CASE 
                        WHEN t.type = 'out' 
                            OR t.transaction_type IN ('clearance', 'exit', 'loading') 
                        THEN ABS(t.qty) 
                        ELSE 0 
                    END
                ) as total_out_qty,
                SUM(
                    CASE 
                        WHEN t.type = 'out' 
                            OR t.transaction_type IN ('clearance', 'exit', 'loading') 
                        THEN ABS(t.weight) 
                        ELSE 0 
                    END
                ) as total_out_weight
            FROM inventory_transactions t
            LEFT JOIN products p ON p.id = t.product_id
            WHERE t.owner_id = $1
            GROUP BY t.product_id, p.name
            HAVING 
                (SUM(CASE WHEN t.type = 'in' THEN t.qty ELSE 0 END) - 
                 SUM(CASE WHEN t.type = 'out' OR t.transaction_type IN ('clearance', 'exit', 'loading') THEN ABS(t.qty) ELSE 0 END)) > 0
        `;

        const { rows } = await pool.query(query, [owner_id]);

        const summary = rows.map(row => ({
            product_id: row.product_id,
            product_title: row.product_title || "نامشخص",
            // موجودی واقعی = ورودی - خروجی
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
   2) Batches - با محاسبه صحیح موجودی
   فرمول: رسید - (خروجی + حواله) = موجودی
============================================================ */
router.get("/batches", authMiddleware, async (req, res) => {
    try {
        const owner_id = req.query.owner_id;
        const product_id = req.query.product_id;

        if (!owner_id || !product_id) {
            return res.status(400).json({ success: false, error: "Missing params" });
        }

        const query = `
            WITH RawData AS (
                SELECT 
                    t.id, t.qty, t.weight, t.created_at,
                    t.batch_no, t.parent_batch_no, t.ref_receipt_id,
                    t.type, t.transaction_type,
                    ri.row_code as receipt_row_code,
                    -- ساختن کلید گروه‌بندی
                    CASE 
                        WHEN t.batch_no IS NOT NULL AND t.batch_no != '' THEN t.batch_no
                        WHEN ri.row_code IS NOT NULL AND ri.row_code != '' THEN ri.row_code
                        ELSE 'NO_BATCH_GROUP'
                    END as grouping_key,
                    -- نام نمایشی
                    CASE 
                        WHEN t.batch_no IS NOT NULL AND t.batch_no != '' THEN t.batch_no
                        WHEN ri.row_code IS NOT NULL AND ri.row_code != '' THEN ri.row_code
                        ELSE 'بدون ردیف'
                    END as display_name
                FROM inventory_transactions t
                LEFT JOIN receipt_items ri ON (
                    (t.ref_receipt_id IS NOT NULL AND t.ref_receipt_id = ri.receipt_id AND t.product_id = ri.product_id)
                    OR
                    (t.reference_id IS NOT NULL AND t.reference_id::text = ri.id::text)
                )
                WHERE t.owner_id = $1 AND t.product_id = $2
            ),
            -- محاسبه موجودی: رسید - (خروجی + حواله)
            StockCalculation AS (
                SELECT 
                    grouping_key,
                    MAX(display_name) as batch_no,
                    -- ورودی (فقط type='in')
                    SUM(CASE WHEN type = 'in' THEN qty ELSE 0 END) as total_in_qty,
                    SUM(CASE WHEN type = 'in' THEN weight ELSE 0 END) as total_in_weight,
                    -- خروجی (type='out' یا transaction_type IN ('clearance', 'exit', 'loading'))
                    SUM(
                        CASE 
                            WHEN type = 'out' 
                                OR transaction_type IN ('clearance', 'exit', 'loading') 
                            THEN ABS(qty) 
                            ELSE 0 
                        END
                    ) as total_out_qty,
                    SUM(
                        CASE 
                            WHEN type = 'out' 
                                OR transaction_type IN ('clearance', 'exit', 'loading') 
                            THEN ABS(weight) 
                            ELSE 0 
                        END
                    ) as total_out_weight,
                    MIN(created_at) as first_transaction_date,
                    json_agg(
                        json_build_object(
                            'id', id,
                            'qty', qty,
                            'weight', weight,
                            'transaction_date', created_at,
                            'batch_no', display_name,
                            'parent_batch_no', parent_batch_no,
                            'type', type,
                            'transaction_type', transaction_type
                        ) ORDER BY created_at
                    ) as history
                FROM RawData
                GROUP BY grouping_key
            )
            SELECT 
                batch_no,
                -- موجودی نهایی = ورودی - خروجی
                (total_in_qty - total_out_qty) as qty_available,
                (total_in_weight - total_out_weight) as weight_available,
                first_transaction_date as transaction_date,
                history
            FROM StockCalculation
            WHERE (total_in_qty - total_out_qty) > 0 
               OR (total_in_weight - total_out_weight) > 0
            ORDER BY first_transaction_date ASC
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
        console.error("❌ Batch Error:", e);
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

        let member_id = await getMemberId(req.user.id);
        if (!member_id) {
            const fb = await client.query("SELECT id FROM members LIMIT 1");
            member_id = fb.rows[0]?.id;
        }

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

        // 1. ثبت هدر
        const insertHeaderSql = `
            INSERT INTO clearances (
                doc_type_id, clearance_no, member_id, status, clearance_date, customer_id,
                receiver_person_name, receiver_person_national_id, driver_name,
                vehicle_plate_iran_right, vehicle_plate_mid3, vehicle_plate_letter, vehicle_plate_left2, description
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            RETURNING id
        `;
        const headerValues = [
            doc_type_id, clearanceNo, member_id, 'final', clearance_date || new Date(), customer_id,
            receiver_person_name, receiver_person_national_id, driver_name,
            pRight, pMid, pLet, pLeft, description
        ];
        
        const headerRes = await client.query(insertHeaderSql, headerValues);
        const clearanceId = headerRes.rows[0].id;

        // 2. ثبت اقلام
        for (const item of items) {
            const qty = toNumber(item.qty);
            const weight = toNumber(item.weight);
            const prodId = item.product_id;

            // ثبت در clearance_items
            await client.query(`
                INSERT INTO clearance_items (
                    clearance_id, product_id, owner_id, qty, weight,
                    parent_batch_no, new_batch_no, manual_ref_id, attachment_url, description, status
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            `, [
                clearanceId, prodId, customer_id, qty, weight,
                item.parent_batch_no, item.new_batch_no, 
                item.manual_ref_id, item.attachment_url, item.description, 'issued'
            ]);
        }

        // ✅ Trigger خودکار inventory_transactions را ثبت می‌کند

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
   4) REPORT - با محاسبه صحیح موجودی
============================================================ */
router.get("/report", authMiddleware, async (req, res) => {
    try {
        const query = `
            SELECT 
                c.*, 
                cust.name as customer_name,
                cust.full_name as customer_full_name
            FROM clearances c
            LEFT JOIN customers cust ON cust.id = c.customer_id
            ORDER BY c.clearance_date DESC
            LIMIT 500
        `;
        
        const { rows: clearances } = await pool.query(query);

        if (clearances.length === 0) return res.json({ success: true, data: [] });

        const ids = clearances.map(c => c.id);
        
        // ✅ اضافه کردن محاسبه موجودی برای هر clearance item
        const itemsQuery = `
            SELECT 
                ci.*,
                p.name as product_name,
                c.clearance_date,
                -- محاسبه موجودی فعلی batch
                (
                    SELECT COALESCE(
                        SUM(CASE WHEN it.type = 'in' THEN it.qty ELSE 0 END) - 
                        SUM(CASE 
                            WHEN it.type = 'out' OR it.transaction_type IN ('clearance', 'exit', 'loading') 
                            THEN ABS(it.qty) 
                            ELSE 0 
                        END), 
                        0
                    )
                    FROM inventory_transactions it
                    WHERE it.owner_id = ci.owner_id 
                      AND it.product_id = ci.product_id
                      AND COALESCE(it.batch_no, '') = COALESCE(ci.parent_batch_no, '')
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
                available_stock: toNumber(it.current_stock) // ✅ موجودی واقعی
            });
        });

        const output = clearances.map(c => ({
            ...c,
            customer: { 
                id: c.customer_id, 
                label: c.customer_name || c.customer_full_name 
            },
            clearance_items: itemsByClearance[c.id] || []
        }));

        res.json({ success: true, data: output });

    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   5) GET ITEMS OF A CLEARANCE - با موجودی صحیح
============================================================ */
router.get("/:clearanceId/items", authMiddleware, async (req, res) => {
    try {
        const { clearanceId } = req.params;

        const query = `
            SELECT 
                ci.*,
                p.name as product_name,
                c.clearance_date,
                -- موجودی واقعی batch در زمان فعلی
                (
                    SELECT COALESCE(
                        SUM(CASE WHEN it.type = 'in' THEN it.qty ELSE 0 END) - 
                        SUM(CASE 
                            WHEN it.type = 'out' OR it.transaction_type IN ('clearance', 'exit', 'loading') 
                            THEN ABS(it.qty) 
                            ELSE 0 
                        END), 
                        0
                    )
                    FROM inventory_transactions it
                    WHERE it.owner_id = ci.owner_id 
                      AND it.product_id = ci.product_id
                      AND COALESCE(it.batch_no, '') = COALESCE(ci.parent_batch_no, '')
                ) as current_stock
            FROM clearance_items ci
            LEFT JOIN products p ON p.id = ci.product_id
            LEFT JOIN clearances c ON c.id = ci.clearance_id
            WHERE ci.clearance_id = $1
            ORDER BY ci.created_at
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

module.exports = router;