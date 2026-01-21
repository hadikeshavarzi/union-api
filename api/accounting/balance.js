// api/accounting/balance.js
const express = require("express");
const { supabaseAdmin } = require("../../supabaseAdmin");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

/* GET CUSTOMER BALANCE */
router.get("/customer-balance/:customerId", authMiddleware, async (req, res) => {
    try {
        const customerId = Number(req.params.customerId);
        const member_id = req.user.id;

        // پیدا کردن تفصیلی مشتری
        const { data: tafsili } = await supabaseAdmin
            .from("accounting_tafsili")
            .select("id")
            .eq("tafsili_type", "customer")
            .eq("ref_id", customerId)
            .eq("member_id", member_id) // ✅ فیلتر تنانت
            .single();

        if (!tafsili) {
            return res.json({
                success: true,
                data: {
                    balance: 0,
                    type: "neutral",
                    formatted: "0 ریال"
                }
            });
        }

        // محاسبه مانده
        const { data: articles } = await supabaseAdmin
            .from("financial_entries")
            .select("bed, bes")
            .eq("tafsili_id", tafsili.id);

        const totalBed = articles?.reduce((sum, a) => sum + (Number(a.bed) || 0), 0) || 0;
        const totalBes = articles?.reduce((sum, a) => sum + (Number(a.bes) || 0), 0) || 0;
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
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* GET CUSTOMER LEDGER */
router.get("/customer-ledger/:customerId", authMiddleware, async (req, res) => {
    try {
        const customerId = Number(req.params.customerId);
        const member_id = req.user.id;

        const { data: tafsili } = await supabaseAdmin
            .from("accounting_tafsili")
            .select("id, title")
            .eq("tafsili_type", "customer")
            .eq("ref_id", customerId)
            .eq("member_id", member_id) // ✅ فیلتر تنانت
            .single();

        if (!tafsili) {
            return res.json({
                success: true,
                data: {
                    entries: [],
                    final_balance: 0,
                    balance_type: "تسویه"
                }
            });
        }

        const { data: entries, error } = await supabaseAdmin
            .from("financial_entries")
            .select(`
                id, bed, bes, description,
                financial_documents!inner (id, doc_date, description, member_id)
            `)
            .eq("tafsili_id", tafsili.id)
            .eq("financial_documents.member_id", member_id) // ✅ فیلتر تنانت
            .order("id", { ascending: true });

        if (error) throw error;

        let runningBalance = 0;
        const ledgerEntries = (entries || []).map(entry => {
            runningBalance += (Number(entry.bed) || 0) - (Number(entry.bes) || 0);
            return {
                ...entry,
                doc_date: entry.financial_documents?.doc_date,
                doc_description: entry.financial_documents?.description,
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
        return res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;