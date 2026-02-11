// api/treasury/operations.js
const express = require("express");
const { pool } = require("../../supabaseAdmin");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

// تابع کمکی داخلی برای پیدا کردن ID معین بر اساس کد
const findMoeinId = async (client, code) => {
    const res = await client.query('SELECT id FROM public.accounting_moein WHERE code = $1 LIMIT 1', [code]);
    return res.rows.length > 0 ? res.rows[0].id : null;
};

// تابع تولید شماره سند (Max + 1)
const generateDocNo = async (client, member_id) => {
    const res = await client.query(
        'SELECT MAX(doc_no::INTEGER) as max_no FROM public.financial_documents WHERE member_id = $1',
        [member_id]
    );
    const max = res.rows[0].max_no || 1000;
    return (Number(max) + 1).toString();
};

/* REGISTER EXIT DOC (ثبت سند خروج) */
router.post("/register-exit-doc", authMiddleware, async (req, res) => {
    const client = await pool.connect();

    try {
        const { exit_id } = req.body;
        const targetExitId = exit_id || req.body.exitId;
        const member_id = req.user.id;

        if (!targetExitId) return res.status(400).json({ success: false, error: "شناسه خروج ارسال نشده است." });

        await client.query('BEGIN'); // شروع تراکنش 🚀

        // ۱. دریافت اطلاعات خروج
        const exitQuery = `
            SELECT * FROM public.warehouse_exits 
            WHERE id = $1 AND member_id = $2
        `;
        const exitRes = await client.query(exitQuery, [targetExitId, member_id]);

        if (exitRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: "سند خروج یافت نشد." });
        }
        const exitRecord = exitRes.rows[0];

        if (exitRecord.accounting_doc_id) {
            await client.query('ROLLBACK');
            return res.json({ success: true, doc_id: exitRecord.accounting_doc_id, message: "سند قبلاً صادر شده است." });
        }

        // ۲. محاسبه مبالغ
        const totalAmount = Number(exitRecord.total_fee || 0) +
            Number(exitRecord.total_loading_fee || 0) +
            Number(exitRecord.weighbridge_fee || 0) +
            Number(exitRecord.extra_fee || 0) +
            Number(exitRecord.vat_fee || 0);

        if (totalAmount <= 0) {
            await client.query('ROLLBACK');
            return res.json({ success: true, message: "مبلغ صفر است، سند صادر نشد." });
        }

        // ==========================================
        //  الف) آماده‌سازی سمت بدهکار (Debtor)
        // ==========================================
        let debtorEntry = null;

        if (exitRecord.payment_method === 'credit') {
            // نسیه: مشتری (10301)
            const moeinId = await findMoeinId(client, "10301");

            // پیدا کردن تفصیلی مشتری
            const custRes = await client.query(
                'SELECT tafsili_id FROM public.customers WHERE id = $1',
                [exitRecord.owner_id]
            );

            if (custRes.rows.length === 0 || !custRes.rows[0].tafsili_id) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, error: "حساب تفصیلی مشتری یافت نشد." });
            }

            debtorEntry = {
                moein_id: moeinId,
                tafsili_id: custRes.rows[0].tafsili_id,
                bed: totalAmount,
                bes: 0,
                description: `بابت خدمات خروج شماره ${exitRecord.exit_no || '-'}`
            };

        } else {
            // نقدی/کارتخوان
            const tafsiliId = exitRecord.financial_account_id;
            if (!tafsiliId) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, error: "حساب بانک/صندوق انتخاب نشده." });
            }

            let moeinCode = "10103"; // بانک
            if (exitRecord.payment_method === 'cash') moeinCode = "10101"; // صندوق
            else if (exitRecord.payment_method === 'pos') moeinCode = "10104"; // کارتخوان

            const moeinId = await findMoeinId(client, moeinCode);

            debtorEntry = {
                moein_id: moeinId,
                tafsili_id: tafsiliId,
                bed: totalAmount,
                bes: 0,
                description: `دریافت وجه بابت خروج ${exitRecord.exit_no || '-'}`
            };
        }

        // ==========================================
        //  ب) آماده‌سازی سمت بستانکار (Creditors)
        // ==========================================
        const creditorEntries = [];

        const feeMap = [
            { amount: exitRecord.total_fee, code: "60101", desc: "درآمد انبارداری" },
            { amount: exitRecord.total_loading_fee, code: "60102", desc: "درآمد بارگیری" },
            { amount: exitRecord.weighbridge_fee, code: "60103", desc: "درآمد باسکول" },
            { amount: exitRecord.extra_fee, code: "60104", desc: "سایر درآمدهای عملیاتی" },
            { amount: exitRecord.vat_fee, code: "30201", desc: "مالیات بر ارزش افزوده" }
        ];

        for (const item of feeMap) {
            if (Number(item.amount) > 0) {
                const mId = await findMoeinId(client, item.code);
                if (mId) {
                    creditorEntries.push({
                        moein_id: mId,
                        tafsili_id: null,
                        bed: 0,
                        bes: Number(item.amount),
                        description: item.desc
                    });
                }
            }
        }

        // ==========================================
        //  ج) ثبت نهایی در دیتابیس
        // ==========================================

        // ۱. ساخت هدر سند
        const docNo = await generateDocNo(client, member_id);
        const docDate = exitRecord.exit_date || new Date().toISOString();

        const insertDocQuery = `
            INSERT INTO public.financial_documents 
            (member_id, doc_no, doc_date, description, status, doc_type)
            VALUES ($1, $2, $3, $4, 'confirmed', 'auto')
            RETURNING id
        `;

        const docDesc = `بابت خدمات خروج شماره ${exitRecord.exit_no || ''} - ${exitRecord.driver_name || ''}`;
        const docRes = await client.query(insertDocQuery, [member_id, docNo, docDate, docDesc]);
        const newDocId = docRes.rows[0].id;

        // ۲. ثبت آرتیکل‌ها
        const allEntries = [debtorEntry, ...creditorEntries];

        for (const entry of allEntries) {
            await client.query(`
                INSERT INTO public.financial_entries 
                (doc_id, member_id, moein_id, tafsili_id, bed, bes, description)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [
                newDocId,
                member_id,
                entry.moein_id,
                entry.tafsili_id,
                entry.bed,
                entry.bes,
                entry.description
            ]);
        }

        // ۳. آپدیت رکورد خروج با آیدی سند جدید
        await client.query(`
            UPDATE public.warehouse_exits 
            SET accounting_doc_id = $1 
            WHERE id = $2
        `, [newDocId, targetExitId]);

        await client.query('COMMIT'); // پایان موفقیت‌آمیز ✅

        return res.json({
            success: true,
            doc_id: newDocId,
            doc_no: docNo,
            message: "سند حسابداری با موفقیت صادر شد."
        });

    } catch (e) {
        await client.query('ROLLBACK'); // بازگشت تغییرات در صورت خطا ❌
        console.error("❌ Register Doc Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

module.exports = router;