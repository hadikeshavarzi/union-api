// api/clearanceItems.js
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

// Helper: دریافت موجودی لحظه‌ای یک ردیف
async function getBatchStock(memberId, ownerId, productId, batchNo) {
    try {
        const query = `
            SELECT qty, weight, batch_no 
            FROM inventory_transactions
            WHERE owner_id = $1 AND product_id = $2
        `;
        // نکته: ما member_id را فیلتر نمی‌کنیم چون ممکن است موجودی قدیمی باشد
        const { rows } = await pool.query(query, [ownerId, productId]);

        const relevantTxs = rows.filter(t => t.batch_no === batchNo);

        const qty = relevantTxs.reduce((sum, t) => sum + toNumber(t.qty), 0);
        const weight = relevantTxs.reduce((sum, t) => sum + toNumber(t.weight), 0);

        return { qty, weight };
    } catch (err) {
        throw new Error("خطا در محاسبه موجودی: " + err.message);
    }
}

/* ============================================================
   1. CREATE ITEM (افزودن آیتم تکی به سند)
============================================================ */
router.post("/", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const member_id = req.user.member_id;

        const { clearance_id, product_id, qty, weight, parent_batch_no, new_batch_no, ...rest } = req.body;

        const reqQty = toNumber(qty);
        const reqWeight = toNumber(weight);

        if (!clearance_id || !product_id) {
            throw new Error("اطلاعات clearance_id و product_id الزامی است");
        }

        // 1. دریافت owner_id از هدر سند
        const clearanceRes = await client.query("SELECT customer_id FROM clearances WHERE id = $1", [clearance_id]);
        if (clearanceRes.rows.length === 0) throw new Error("سند ترخیص یافت نشد");
        const owner_id = clearanceRes.rows[0].customer_id;

        // 2. بررسی موجودی (اختیاری - اگر مایلید جلوی منفی شدن را بگیرید)
        if (parent_batch_no) {
            const stock = await getBatchStock(member_id, owner_id, product_id, parent_batch_no);
            if (stock.qty < reqQty) {
                // اگر نمی‌خواهید سخت‌گیری کنید این خط را کامنت کنید
                // throw new Error(`موجودی کافی نیست. موجودی فعلی: ${stock.qty}`);
            }
        }

        // 3. ثبت آیتم در clearance_items
        const insertItemSql = `
            INSERT INTO clearance_items (
                clearance_id, product_id, owner_id, qty, weight,
                parent_batch_no, new_batch_no, manual_ref_id, attachment_url, description, status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING *
        `;
        const itemRes = await client.query(insertItemSql, [
            clearance_id, product_id, owner_id, reqQty, reqWeight,
            parent_batch_no, new_batch_no, 
            rest.manual_ref_id, rest.attachment_url, rest.description, 'issued'
        ]);
        const newItem = itemRes.rows[0];

        // 4. ثبت تراکنش کسر موجودی
        // استفاده از نام ستون‌های دقیق جدول شما: ref_clearance_id, reference_id, type='out'
        await client.query(`
            INSERT INTO inventory_transactions (
                member_id, owner_id, product_id, qty, weight,
                batch_no, parent_batch_no,
                type, transaction_type, ref_clearance_id, reference_id, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'out', 'clearance', $8, $9, NOW())
        `, [
            member_id, owner_id, product_id, 
            -Math.abs(reqQty), -Math.abs(reqWeight), 
            new_batch_no, parent_batch_no, 
            clearance_id, newItem.id
        ]);

        await client.query('COMMIT');
        res.json({ success: true, data: newItem });

    } catch (e) {
        await client.query('ROLLBACK');
        console.error("Add Item Error:", e);
        res.status(500).json({ error: e.message });
    } finally {
        client.release();
    }
});

/* ============================================================
   2. DELETE ITEM (حذف آیتم تکی)
============================================================ */
router.delete("/:id", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { id } = req.params;

        // 1. پیدا کردن آیتم
        const itemRes = await client.query("SELECT id FROM clearance_items WHERE id = $1", [id]);
        if (itemRes.rows.length === 0) throw new Error("آیتم یافت نشد");

        // 2. حذف تراکنش مربوطه (برگشت موجودی)
        // تراکنش‌هایی که reference_id آن‌ها برابر با ID آیتم حذف شده است
        await client.query("DELETE FROM inventory_transactions WHERE reference_id = $1::text", [id]);

        // 3. حذف خود آیتم
        await client.query("DELETE FROM clearance_items WHERE id = $1", [id]);

        await client.query('COMMIT');
        res.json({ success: true, message: "آیتم حذف شد و موجودی برگشت" });

    } catch (e) {
        await client.query('ROLLBACK');
        console.error("Delete Item Error:", e);
        res.status(500).json({ error: e.message });
    } finally {
        client.release();
    }
});

module.exports = router;