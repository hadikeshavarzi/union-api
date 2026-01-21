// api/reports/index.js
const express = require("express");
const { supabaseAdmin } = require("../../supabaseAdmin");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

/* Customer Balance Report */
router.get("/customer-balance", authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.id;

        // دریافت همه تفصیلی‌های مشتریان
        const { data: tafsilis } = await supabaseAdmin
            .from("accounting_tafsili")
            .select("id, code, title, ref_id")
            .eq("member_id", member_id)
            .eq("tafsili_type", "customer")
            .eq("is_active", true);

        if (!tafsilis || tafsilis.length === 0) {
            return res.json({ success: true, data: [] });
        }

        // محاسبه مانده برای هر تفصیلی
        const balances = [];

        for (const tafsili of tafsilis) {
            const { data: entries } = await supabaseAdmin
                .from("financial_entries")
                .select("bed, bes")
                .eq("tafsili_id", tafsili.id);

            const totalBed = entries?.reduce((sum, e) => sum + (Number(e.bed) || 0), 0) || 0;
            const totalBes = entries?.reduce((sum, e) => sum + (Number(e.bes) || 0), 0) || 0;
            const balance = totalBed - totalBes;

            if (balance !== 0) {
                balances.push({
                    tafsili_id: tafsili.id,
                    code: tafsili.code,
                    title: tafsili.title,
                    balance: Math.abs(balance),
                    type: balance > 0 ? "debtor" : "creditor"
                });
            }
        }

        return res.json({ success: true, data: balances });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* Account Ledger (Moein or Tafsili) */
router.get("/account-ledger", authMiddleware, async (req, res) => {
    try {
        const { moein_id, tafsili_id, from_date, to_date } = req.query;

        if (!moein_id && !tafsili_id) {
            return res.status(400).json({
                success: false,
                error: "معین یا تفصیلی الزامی است"
            });
        }

        let query = supabaseAdmin
            .from("financial_entries")
            .select(`
                *,
                financial_documents!inner (id, doc_date, description, member_id)
            `)
            .eq("financial_documents.member_id", req.user.id)
            .order("id", { ascending: true });

        if (moein_id) query = query.eq("moein_id", moein_id);
        if (tafsili_id) query = query.eq("tafsili_id", tafsili_id);

        if (from_date) {
            query = query.gte("financial_documents.doc_date", from_date);
        }
        if (to_date) {
            query = query.lte("financial_documents.doc_date", to_date);
        }

        const { data: entries, error } = await query;

        if (error) throw error;

        let runningBalance = 0;
        const ledger = (entries || []).map(entry => {
            runningBalance += (Number(entry.bed) || 0) - (Number(entry.bes) || 0);
            return {
                ...entry,
                doc_date: entry.financial_documents?.doc_date,
                doc_description: entry.financial_documents?.description,
                running_balance: runningBalance
            };
        });

        return res.json({ success: true, data: ledger });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* General Ledger */
router.get("/general-ledger", authMiddleware, async (req, res) => {
    try {
        res.json({
            success: true,
            data: [],
            message: "این گزارش به زودی اضافه می‌شود"
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* Journal Report */
router.get("/journal", authMiddleware, async (req, res) => {
    try {
        const { from_date, to_date } = req.query;
        const member_id = req.user.id;

        let query = supabaseAdmin
            .from("financial_documents")
            .select(`
                *,
                financial_entries (
                    *,
                    moein:accounting_moein(code, title),
                    tafsili:accounting_tafsili(code, title)
                )
            `)
            .eq("member_id", member_id)
            .order("doc_date", { ascending: true });

        if (from_date) query = query.gte("doc_date", from_date);
        if (to_date) query = query.lte("doc_date", to_date);

        const { data, error } = await query;

        if (error) throw error;

        return res.json({ success: true, data: data || [] });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;