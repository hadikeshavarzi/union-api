const express = require("express");
const router = express.Router();
const { pool } = require("../../supabaseAdmin"); // مسیر احتمالی کانکشن دیتابیس (دو پله بالاتر)
const authMiddleware = require("../middleware/auth"); // مسیر میدل‌ور (یک پله بالاتر)

// --- Helper Functions ---
const isUUID = (str) => str && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
const toNum = (v) => (v ? Number(String(v).replace(/,/g, "")) : 0);

// =====================================================================
// POST /api/treasury/register-receipt-doc
// ثبت سند مالی اتوماتیک برای رسید انبار
// =====================================================================
router.post("/register-receipt-doc", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const member_id = req.user.member_id;
        const { 
            paymentAmount, date, customerId, sourceId, 
            receiptId, receiptNo, description 
        } = req.body;

        if (!paymentAmount || !customerId || !sourceId) {
            return res.status(400).json({ success: false, error: "اطلاعات سند ناقص است" });
        }

        const amount = toNum(paymentAmount);
        if (amount <= 0) return res.status(400).json({ success: false, error: "مبلغ نامعتبر" });

        await client.query("BEGIN");

        // 1. دریافت شماره سند جدید
        const docRes = await client.query(`
            SELECT COALESCE(MAX(doc_no), 1000)::bigint + 1 as next_no 
            FROM public.financial_documents WHERE member_id = $1
        `, [member_id]);
        const nextDocNo = docRes.rows[0].next_no;

        // 2. ثبت هدر سند
        const insertDocSql = `
            INSERT INTO public.financial_documents (
                member_id, doc_no, doc_date, doc_type, 
                description, status, created_at, updated_at
            ) VALUES ($1, $2, $3, 'payment_order', $4, 'approved', NOW(), NOW()) 
            RETURNING id
        `;
        const docResult = await client.query(insertDocSql, [
            member_id, nextDocNo, date || new Date(), 
            description || `هزینه‌های رسید انبار شماره ${receiptNo}`
        ]);
        const newDocId = docResult.rows[0].id;

        // 3. ثبت آرتیکل‌ها (بدهکار: مشتری | بستانکار: صندوق/بانک)
        // آرتیکل بدهکار (مشتری)
        await client.query(`
            INSERT INTO public.financial_document_items (
                doc_id, tafsili_id, description, debtor, creditor, created_at
            ) VALUES ($1, $2, $3, $4, 0, NOW())
        `, [newDocId, customerId, description, amount]);

        // آرتیکل بستانکار (منبع پرداخت)
        await client.query(`
            INSERT INTO public.financial_document_items (
                doc_id, tafsili_id, description, debtor, creditor, created_at
            ) VALUES ($1, $2, $3, 0, $4, NOW())
        `, [newDocId, sourceId, description, amount]);

        // 4. اتصال به رسید (آپدیت جدول receipts)
        if (isUUID(receiptId)) {
            // فرض بر این است که ستون financial_doc_id در جدول receipts دارید
            // اگر ندارید، این بخش را کامنت کنید یا ستون را بسازید
             await client.query(`
                 UPDATE public.receipts SET financial_doc_id = $1 WHERE id = $2
             `, [newDocId, receiptId]);
        }

        await client.query("COMMIT");

        res.json({ success: true, message: "سند مالی ثبت شد", data: { doc_id: newDocId, doc_no: nextDocNo } });

    } catch (e) {
        await client.query("ROLLBACK");
        console.error("❌ Register Receipt Doc Error:", e);
        res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

// اگر فایل‌های دیگری مثل banks.js و cashes.js دارید، می‌توانید آن‌ها را هم اینجا mount کنید
// مثلا: router.use('/banks', require('./banks')); 
// اما فعلاً همین کافیست.

module.exports = router;