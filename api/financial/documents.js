// api/financial/documents.js
const express = require("express");
const { supabaseAdmin } = require("../../supabaseAdmin");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

/* GET ALL DOCUMENTS */
router.get("/", authMiddleware, async (req, res) => {
    try {
        const { search, limit = 500 } = req.query;
        const member_id = req.user.id;

        let query = supabaseAdmin
            .from("financial_documents")
            .select(`
                id, doc_date, description, manual_no, created_at, doc_type, status,
                financial_entries (bed, bes)
            `)
            .eq("member_id", member_id)
            .order("id", { ascending: false })
            .limit(Number(limit));

        if (search) {
            const terms = search.split('|');
            const orConditions = terms.map(term => `description.ilike.%${term}%`).join(',');
            query = query.or(orConditions);
        }

        const { data, error } = await query;

        if (error) throw error;

        const documents = (data || []).map(doc => {
            const total = doc.financial_entries?.reduce((sum, e) => sum + (Number(e.bed) || 0), 0) || 0;
            return { ...doc, total_amount: total };
        });

        return res.json({ success: true, data: documents });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* GET ONE DOCUMENT */
router.get("/:id", authMiddleware, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from("financial_documents")
            .select(`
                *,
                financial_entries (
                    *,
                    moein:accounting_moein(id, code, title),
                    tafsili:accounting_tafsili(id, code, title)
                )
            `)
            .eq("id", req.params.id)
            .eq("member_id", req.user.id)
            .single();

        if (error || !data) {
            return res.status(404).json({ success: false, error: "سند یافت نشد" });
        }

        return res.json({ success: true, data });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* CREATE DOCUMENT WITH ENTRIES */
router.post("/create-with-entries", authMiddleware, async (req, res) => {
    try {
        const { header, entries } = req.body;
        const member_id = req.user.id;

        if (!header || !entries || entries.length === 0) {
            return res.status(400).json({
                success: false,
                error: "اطلاعات سند ناقص است"
            });
        }

        // 1. ثبت هدر سند
        const { data: doc, error: docError } = await supabaseAdmin
            .from("financial_documents")
            .insert({
                ...header,
                member_id,
                status: header.status || 'confirmed'
            })
            .select()
            .single();

        if (docError) throw docError;

        // 2. ثبت آرتیکل‌ها
        const formattedEntries = entries.map(entry => ({
            doc_id: doc.id,
            moein_id: entry.moein_id,
            tafsili_id: entry.tafsili_id,
            description: entry.description,
            bed: Number(entry.bed) || 0,
            bes: Number(entry.bes) || 0
        }));

        const { error: entryError } = await supabaseAdmin
            .from("financial_entries")
            .insert(formattedEntries);

        if (entryError) {
            // رول‌بک
            await supabaseAdmin
                .from("financial_documents")
                .delete()
                .eq("id", doc.id);
            throw entryError;
        }

        return res.json({
            success: true,
            data: doc,
            message: "سند با موفقیت ثبت شد"
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* CREATE MANUAL DOCUMENT */
router.post("/manual", authMiddleware, async (req, res) => {
    try {
        // مشابه create-with-entries
        return res.json({
            success: true,
            message: "از endpoint /create-with-entries استفاده کنید"
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* UPDATE DOCUMENT */
router.put("/:id", authMiddleware, async (req, res) => {
    try {
        const payload = { ...req.body };
        delete payload.id;
        delete payload.member_id;
        delete payload.created_at;

        const { data, error } = await supabaseAdmin
            .from("financial_documents")
            .update(payload)
            .eq("id", req.params.id)
            .eq("member_id", req.user.id)
            .select()
            .single();

        if (error || !data) {
            return res.status(404).json({
                success: false,
                error: "سند یافت نشد یا دسترسی ندارید"
            });
        }

        return res.json({
            success: true,
            data,
            message: "سند با موفقیت ویرایش شد"
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* DELETE DOCUMENT */
router.delete("/:id", authMiddleware, async (req, res) => {
    try {
        const doc_id = Number(req.params.id);
        const member_id = req.user.id;

        // چک دسترسی
        const { data: doc } = await supabaseAdmin
            .from("financial_documents")
            .select("id")
            .eq("id", doc_id)
            .eq("member_id", member_id)
            .single();

        if (!doc) {
            return res.status(404).json({
                success: false,
                error: "سند یافت نشد یا دسترسی ندارید"
            });
        }

        // حذف آرتیکل‌ها
        await supabaseAdmin
            .from("financial_entries")
            .delete()
            .eq("doc_id", doc_id);

        // حذف سند
        await supabaseAdmin
            .from("financial_documents")
            .delete()
            .eq("id", doc_id);

        return res.json({
            success: true,
            message: "سند با موفقیت حذف شد"
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;