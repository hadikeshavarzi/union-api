// api/loadings.js
const express = require("express");
const { pool } = require("../supabaseAdmin");
const authMiddleware = require("./middleware/auth");

const router = express.Router();

/* ============================================================
   Helpers
============================================================ */

async function resolveMemberId(req) {
    return req.user?.member_id || req.user?.id || null;
}

async function generateOrderNo(client, memberId) {
    const { rows } = await client.query(
        `SELECT COALESCE(MAX(order_no), 5000) AS max_no FROM public.loading_orders WHERE member_id = $1`,
        [memberId]
    );
    return Number(rows[0]?.max_no || 5000) + 1;
}

function formatPlate(plateObj) {
    if (!plateObj) return null;
    if (typeof plateObj === "string") return plateObj;
    const { right2, middle3, letter, left2 } = plateObj;
    if (!right2 && !middle3 && !letter && !left2) return null;
    return `${left2}-${middle3}-${letter}-${right2}`;
}

/* ============================================================
   0-A) GET /api/loadings/customers-with-clearances
   مشتریانی که حواله ترخیص (issued) دارند و هنوز بارگیری نشده
============================================================ */
router.get("/customers-with-clearances", authMiddleware, async (req, res) => {
    try {
        const query = `
            SELECT DISTINCT
                c.id,
                COALESCE(c.name, 'بدون نام') AS name,
                c.mobile,
                c.national_id,
                c.customer_type,
                COUNT(ci.id) AS pending_count
            FROM clearance_items ci
            JOIN clearances cl ON cl.id = ci.clearance_id
            JOIN customers c   ON c.id = cl.customer_id
            LEFT JOIN loading_order_items li ON li.clearance_item_id = ci.id
            WHERE ci.status = 'issued'
              AND cl.status = 'final'
              AND li.id IS NULL
            GROUP BY c.id, c.name, c.mobile, c.national_id, c.customer_type
            ORDER BY name
        `;
        const { rows } = await pool.query(query);
        res.json({ success: true, data: rows });
    } catch (e) {
        console.error("❌ customers-with-clearances error:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   0-B) GET /api/loadings/pending-items/:customerId
   آیتم‌های حواله‌شده یک مشتری که هنوز بارگیری نشده‌اند
============================================================ */
router.get("/pending-items/:customerId", authMiddleware, async (req, res) => {
    try {
        const customerId = req.params.customerId;
        const query = `
            SELECT
                ci.id            AS item_id,
                ci.clearance_id,
                ci.product_id,
                ci.qty,
                ci.weight,
                ci.parent_batch_no,
                ci.new_batch_no,
                ci.batch_no,
                ci.status        AS item_status,
                ci.description   AS item_desc,
                cl.clearance_no,
                cl.clearance_date,
                cl.receiver_person_name,
                cl.receiver_person_national_id,
                cl.driver_name   AS cl_driver_name,
                cl.vehicle_plate_left2,
                cl.vehicle_plate_mid3,
                cl.vehicle_plate_letter,
                cl.vehicle_plate_iran_right,
                p.name           AS product_name,
                pc.name          AS category_name
            FROM clearance_items ci
            JOIN clearances cl          ON cl.id = ci.clearance_id
            LEFT JOIN products p        ON p.id  = ci.product_id
            LEFT JOIN product_categories pc ON pc.id = p.category_id
            LEFT JOIN loading_order_items li ON li.clearance_item_id = ci.id
            WHERE cl.customer_id = $1
              AND ci.status = 'issued'
              AND cl.status = 'final'
              AND li.id IS NULL
              -- فیلتر: اگر ردیف فرزند دارد، نمایش نده (فقط آخرین سطح نستد بیاد)
              AND NOT EXISTS (
                  SELECT 1 FROM clearance_items ci2
                  JOIN clearances cl2 ON cl2.id = ci2.clearance_id
                  WHERE ci2.parent_batch_no = ci.new_batch_no
                    AND cl2.customer_id = $1
                    AND ci2.status = 'issued'
                    AND cl2.status = 'final'
                    AND ci2.product_id = ci.product_id
              )
            ORDER BY cl.clearance_no ASC, ci.created_at ASC
        `;
        const { rows } = await pool.query(query, [customerId]);
        res.json({ success: true, data: rows });
    } catch (e) {
        console.error("❌ pending-items error:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   1) POST /api/loadings - ثبت دستور بارگیری (Transactional)
============================================================ */
router.post("/", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const memberId = req.user.member_id;

        const {
            clearance_id,
            customer_id,
            loading_date,
            driver_name,
            plate,
            description,
            items = [],
        } = req.body || {};

        if (!items.length || !driver_name) {
            return res.status(400).json({ success: false, error: "آیتم و نام راننده الزامی هستند" });
        }

        await client.query('BEGIN');

        const orderNo = await generateOrderNo(client, memberId);
        const plateString = formatPlate(plate);

        const headerQuery = `
            INSERT INTO public.loading_orders (
                member_id, order_no, clearance_id, status, loading_date, 
                driver_name, plate_number, description, warehouse_keeper_id
            ) VALUES ($1, $2, $3, 'issued', $4, $5, $6, $7, $8)
            RETURNING id
        `;
        const headerValues = [
            memberId, orderNo, clearance_id || null,
            loading_date || new Date().toISOString(),
            driver_name, plateString, description || null, memberId
        ];

        const { rows: [order] } = await client.query(headerQuery, headerValues);

        for (const it of items) {
            if (!it.product_id) throw new Error("product_id در آیتم‌ها الزامی است");

            await client.query(`
                INSERT INTO public.loading_order_items (
                    loading_order_id, clearance_item_id, product_id, qty, weight, batch_no
                ) VALUES ($1, $2, $3, $4, $5, $6)
            `, [
                order.id,
                it.clearance_item_id || null,
                it.product_id,
                Number(it.qty || 0),
                Number(it.weight || 0),
                it.batch_no || null
            ]);

            // ثبت تراکنش خروج (بارگیری) در inventory_transactions
            if (it.product_id && customer_id) {
                await client.query(`
                    INSERT INTO inventory_transactions (
                        type, transaction_type, reference_id,
                        product_id, owner_id, member_id,
                        qty, weight, batch_no,
                        transaction_date, created_at, updated_at
                    ) VALUES (
                        'out', 'loading', $1, $2, $3, $4,
                        $5, $6, $7, $8, NOW(), NOW()
                    )
                `, [
                    order.id,
                    it.product_id,
                    customer_id,
                    memberId,
                    Number(it.qty || 0),
                    Number(it.weight || 0),
                    it.batch_no || '',
                    loading_date || new Date()
                ]);
            }
        }

        await client.query('COMMIT');
        return res.json({
            success: true,
            data: { id: order.id, order_no: orderNo },
            message: "دستور بارگیری با موفقیت صادر شد",
        });

    } catch (e) {
        await client.query('ROLLBACK');
        console.error("❌ POST /loadings error:", e.message);
        return res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

/* ============================================================
   2) GET /api/loadings - لیست بارگیری‌ها
============================================================ */
router.get("/", authMiddleware, async (req, res) => {
    try {
        const memberId = await resolveMemberId(req);

        const query = `
            SELECT lo.*,
            c.name AS customer_name,
            COALESCE(
                (SELECT json_agg(
                    json_build_object(
                        'id', li.id,
                        'qty', li.qty,
                        'weight', li.weight,
                        'batch_no', li.batch_no,
                        'product_name', p.name,
                        'category_name', pc.name
                    )
                )
                FROM public.loading_order_items li
                LEFT JOIN products p ON p.id = li.product_id
                LEFT JOIN product_categories pc ON pc.id = p.category_id
                WHERE li.loading_order_id = lo.id),
            '[]') as items
            FROM public.loading_orders lo
            LEFT JOIN clearances cl ON cl.id = lo.clearance_id
            LEFT JOIN customers c ON c.id = cl.customer_id
            WHERE lo.member_id = $1
            ORDER BY lo.created_at DESC
        `;

        const { rows } = await pool.query(query, [memberId]);
        return res.json({ success: true, data: rows });

    } catch (e) {
        console.error("❌ GET /loadings error:", e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   3) GET /api/loadings/:id - جزئیات یک بارگیری
============================================================ */
router.get("/:id", authMiddleware, async (req, res) => {
    try {
        const memberId = await resolveMemberId(req);
        const id = req.params.id;

        // header + customer info
        const headerQuery = `
            SELECT lo.*,
                   c.name AS customer_name,
                   c.mobile AS customer_mobile,
                   c.national_id AS customer_national_id,
                   cl.clearance_no,
                   cl.receiver_person_name,
                   cl.receiver_person_national_id
            FROM public.loading_orders lo
            LEFT JOIN clearances cl ON cl.id = lo.clearance_id
            LEFT JOIN customers c  ON c.id  = cl.customer_id
            WHERE lo.id = $1 AND lo.member_id = $2
        `;
        const { rows: headerRows } = await pool.query(headerQuery, [id, memberId]);

        if (!headerRows.length) {
            return res.status(404).json({ success: false, error: "بارگیری یافت نشد" });
        }

        // items
        const itemsQuery = `
            SELECT li.id, li.qty, li.weight, li.batch_no,
                   p.name AS product_name,
                   pc.name AS category_name
            FROM public.loading_order_items li
            LEFT JOIN products p ON p.id = li.product_id
            LEFT JOIN product_categories pc ON pc.id = p.category_id
            WHERE li.loading_order_id = $1
        `;
        const { rows: itemRows } = await pool.query(itemsQuery, [id]);

        const result = { ...headerRows[0], items: itemRows };
        return res.json({ success: true, data: result });

    } catch (e) {
        console.error("❌ GET /loadings/:id error:", e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   4) DELETE /api/loadings/:id - حذف بارگیری (Transactional)
============================================================ */
router.delete("/:id", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const memberId = await resolveMemberId(req);
        const id = req.params.id;

        await client.query('BEGIN');

        // بررسی وجود سند
        const { rows: loRows } = await client.query(
            `SELECT id FROM public.loading_orders WHERE id = $1 AND member_id = $2`,
            [id, memberId]
        );
        if (!loRows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: "سند یافت نشد یا دسترسی ندارید" });
        }

        // بررسی اینکه خروج نشده باشد
        const { rows: exitRows } = await client.query(
            `SELECT id FROM warehouse_exits WHERE loading_order_id = $1 LIMIT 1`,
            [id]
        );
        if (exitRows.length) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: "این دستور خروج شده و قابل حذف نیست" });
        }

        // ۱. حذف تراکنش‌های مرتبط
        await client.query(
            `DELETE FROM inventory_transactions WHERE transaction_type = 'loading' AND reference_id = $1`,
            [id]
        );

        // ۲. حذف آیتم‌ها
        await client.query(
            `DELETE FROM public.loading_order_items WHERE loading_order_id = $1`,
            [id]
        );

        // ۳. حذف هدر
        await client.query(
            `DELETE FROM public.loading_orders WHERE id = $1`,
            [id]
        );

        await client.query('COMMIT');
        return res.json({ success: true, message: "دستور بارگیری با موفقیت حذف شد" });

    } catch (e) {
        await client.query('ROLLBACK');
        console.error("❌ DELETE /loadings/:id error:", e.message);
        return res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

module.exports = router;