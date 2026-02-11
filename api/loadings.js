// api/loadings.js (Converted to PostgreSQL)
const express = require("express");
const { pool } = require("../supabaseAdmin"); // اطمینان از صحت مسیر
const authMiddleware = require("./middleware/auth");

const router = express.Router();

/* ============================================================
   Helpers (SQL Versions)
============================================================ */

// تولید شماره دستور بارگیری
async function generateOrderNo(client, memberId) {
    const { rows } = await client.query(
        `SELECT COUNT(*) as count FROM public.loading_orders WHERE member_id = $1`,
        [memberId]
    );
    const count = Number(rows[0]?.count || 0);
    return (Number(memberId) * 1000) + 5000 + (count + 1);
}

// تبدیل پلاک از object به string
function formatPlate(plateObj) {
    if (!plateObj) return null;
    if (typeof plateObj === "string") return plateObj;

    const { right2, middle3, letter, left2 } = plateObj;
    if (!right2 || !middle3 || !letter || !left2) return null;
    return `${left2}-${middle3}-${letter}-${right2}`;
}

/* ============================================================
   1) POST /api/loadings - ثبت دستور بارگیری (Transactional)
============================================================ */
router.post("/", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const memberId = req.user.id;
        const {
            clearance_id,
            loading_date,
            driver_name,
            plate,
            description,
            items = [],
        } = req.body || {};

        if (!clearance_id || !driver_name) {
            return res.status(400).json({ success: false, error: "clearance_id و نام راننده الزامی هستند" });
        }

        await client.query('BEGIN'); // 🚀 شروع تراکنش

        const orderNo = await generateOrderNo(client, memberId);
        const plateString = formatPlate(plate);

        // ۱) ایجاد هدر
        const headerQuery = `
            INSERT INTO public.loading_orders (
                member_id, order_no, clearance_id, status, loading_date, 
                driver_name, plate_number, description, warehouse_keeper_id
            ) VALUES ($1, $2, $3, 'issued', $4, $5, $6, $7, $8)
            RETURNING id
        `;
        const headerValues = [
            memberId, orderNo, Number(clearance_id),
            loading_date || new Date().toISOString(),
            driver_name, plateString, description || null, memberId
        ];

        const { rows: [order] } = await client.query(headerQuery, headerValues);

        // ۲) ایجاد آیتم‌ها
        if (Array.isArray(items) && items.length > 0) {
            for (const it of items) {
                if (!it.product_id) {
                    throw new Error("product_id در آیتم‌ها الزامی است");
                }
                await client.query(`
                    INSERT INTO public.loading_order_items (
                        loading_order_id, clearance_item_id, product_id, qty, weight, batch_no
                    ) VALUES ($1, $2, $3, $4, $5, $6)
                `, [
                    order.id,
                    it.clearance_item_id ? Number(it.clearance_item_id) : null,
                    Number(it.product_id),
                    Number(it.qty || 0),
                    Number(it.weight || 0),
                    it.batch_no || null
                ]);
            }
        }

        await client.query('COMMIT'); // ✅ تایید نهایی تراکنش
        return res.json({
            success: true,
            data: { id: order.id, order_no: orderNo },
            message: "دستور بارگیری با موفقیت صادر شد",
        });

    } catch (e) {
        await client.query('ROLLBACK'); // ❌ لغو کامل عملیات در صورت خطا
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
        const memberId = req.user.id;

        // دریافت هدرها و آیتم‌ها با استفاده از JSON_AGG در یک کوئری (بهینه)
        const query = `
            SELECT lo.*, 
            COALESCE(
                (SELECT json_agg(li.*) 
                 FROM public.loading_order_items li 
                 WHERE li.loading_order_id = lo.id), 
            '[]') as items
            FROM public.loading_orders lo
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
        const memberId = req.user.id;
        const id = Number(req.params.id);

        const query = `
            SELECT lo.*, 
            COALESCE(
                (SELECT json_agg(
                    json_build_object(
                        'id', li.id,
                        'qty', li.qty,
                        'weight', li.weight,
                        'batch_no', li.batch_no,
                        'product', (SELECT json_build_object('id', p.id, 'name', p.name) FROM public.products p WHERE p.id = li.product_id)
                    )
                 FROM public.loading_order_items li 
                 WHERE li.loading_order_id = lo.id), 
            '[]') as items
            FROM public.loading_orders lo
            WHERE lo.id = $1 AND lo.member_id = $2
        `;

        const { rows } = await pool.query(query, [id, memberId]);

        if (rows.length === 0) {
            return res.status(404).json({ success: false, error: "بارگیری یافت نشد" });
        }

        return res.json({ success: true, data: rows[0] });
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
        const memberId = req.user.id;
        const id = Number(req.params.id);

        await client.query('BEGIN');

        // ۱. حذف آیتم‌ها
        await client.query(
            `DELETE FROM public.loading_order_items 
             WHERE loading_order_id IN (SELECT id FROM public.loading_orders WHERE id = $1 AND member_id = $2)`,
            [id, memberId]
        );

        // ۲. حذف هدر
        const { rowCount } = await client.query(
            `DELETE FROM public.loading_orders WHERE id = $1 AND member_id = $2`,
            [id, memberId]
        );

        if (rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: "سند یافت نشد یا دسترسی ندارید" });
        }

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