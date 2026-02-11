// api/accounting/balance.js
const express = require("express");
const { pool } = require("../../supabaseAdmin"); // فقط pool رو نیاز داریم
const authMiddleware = require("../middleware/auth");

const router = express.Router();

/* GET CUSTOMER BALANCE */
router.get("/customer-balance/:customerId", authMiddleware, async (req, res) => {
    try {
        // ⚠️ تغییر مهم: چون آیدی‌ها UUID شدند، نباید Number() استفاده کنیم
        const customerId = req.params.customerId;
        const member_id = req.user.id;

        // ۱. پیدا کردن تفصیلی مشتری با SQL مستقیم
        const tafsiliQuery = `
            SELECT id 
            FROM public.accounting_tafsili 
            WHERE tafsili_type = 'customer' 
            AND ref_id = $1 
            AND member_id = $2
            LIMIT 1
        `;
        const tafsiliResult = await pool.query(tafsiliQuery, [customerId, member_id]);

        if (tafsiliResult.rows.length === 0) {
            return res.json({
                success: true,
                data: {
                    balance: 0,
                    type: "neutral",
                    formatted: "0 ریال"
                }
            });
        }

        const tafsiliId = tafsiliResult.rows[0].id;

        // ۲. محاسبه مانده (جمع زدن مستقیم در دیتابیس برای سرعت بالاتر)
        const balanceQuery = `
            SELECT 
                COALESCE(SUM(bed), 0) as total_bed, 
                COALESCE(SUM(bes), 0) as total_bes
            FROM public.financial_entries 
            WHERE tafsili_id = $1
        `;
        const balanceResult = await pool.query(balanceQuery, [tafsiliId]);

        const totalBed = Number(balanceResult.rows[0].total_bed);
        const totalBes = Number(balanceResult.rows[0].total_bes);
        const balance = totalBed - totalBes;

        return res.json({
            success: true,
            data: {
                balance: Math.abs(balance),
                type: balance > 0 ? "debtor" : balance < 0 ? "creditor" : "neutral",
                formatted: `${Math.abs(balance).toLocaleString("fa-IR")} ریال`
            }
        });

    } catch (e) {
        console.error("Error in customer-balance:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* GET CUSTOMER LEDGER */
router.get("/customer-ledger/:customerId", authMiddleware, async (req, res) => {
    try {
        // ⚠️ تغییر مهم: دریافت به صورت UUID (رشته)
        const customerId = req.params.customerId;
        const member_id = req.user.id;

        // ۱. پیدا کردن تفصیلی
        const tafsiliQuery = `
            SELECT id, title 
            FROM public.accounting_tafsili 
            WHERE tafsili_type = 'customer' 
            AND ref_id = $1 
            AND member_id = $2
            LIMIT 1
        `;
        const tafsiliResult = await pool.query(tafsiliQuery, [customerId, member_id]);

        if (tafsiliResult.rows.length === 0) {
            return res.json({
                success: true,
                data: {
                    entries: [],
                    final_balance: 0,
                    balance_type: "تسویه"
                }
            });
        }

        const tafsili = tafsiliResult.rows[0];

        // ۲. دریافت گردش حساب با JOIN
        // نکته: در Supabase از financial_documents!inner استفاده می‌شد، اینجا JOIN می‌زنیم
        const ledgerQuery = `
            SELECT 
                e.id, 
                e.bed, 
                e.bes, 
                e.description,
                d.id as doc_id,
                d.doc_date, 
                d.description as doc_description
            FROM public.financial_entries e
            INNER JOIN public.financial_documents d ON e.doc_id = d.id
            WHERE e.tafsili_id = $1
            AND d.member_id = $2 -- فیلتر امنیتی تنانت
            ORDER BY e.id ASC
        `;

        const entriesResult = await pool.query(ledgerQuery, [tafsili.id, member_id]);
        const entries = entriesResult.rows;

        // ۳. محاسبه مانده در لحظه (Running Balance) با جاوااسکریپت
        let runningBalance = 0;
        const ledgerEntries = entries.map(entry => {
            const bed = Number(entry.bed) || 0;
            const bes = Number(entry.bes) || 0;
            runningBalance += (bed - bes);

            return {
                id: entry.id,
                bed: bed,
                bes: bes,
                description: entry.description,
                doc_id: entry.doc_id,
                doc_date: entry.doc_date,
                doc_description: entry.doc_description,
                running_balance: runningBalance
            };
        });

        return res.json({
            success: true,
            data: {
                tafsili_title: tafsili.title,
                entries: ledgerEntries,
                final_balance: runningBalance,
                balance_type: runningBalance > 0 ? "بدهکار" : runningBalance < 0 ? "بستانکار" : "تسویه"
            }
        });

    } catch (e) {
        console.error("Error in customer-ledger:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;