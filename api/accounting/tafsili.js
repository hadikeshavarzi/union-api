// api/accounting/tafsili.js
const express = require("express");
const { supabaseAdmin } = require("../../supabaseAdmin");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

/* GET ALL TAFSILI */
router.get("/", authMiddleware, async (req, res) => {
    try {
        const {
            is_active,
            exclude_types,
            tafsili_type,
            limit = 500,
            search
        } = req.query;

        const member_id = req.user.id;

        let query = supabaseAdmin
            .from("accounting_tafsili")
            .select("id, code, title, tafsili_type, is_active, ref_id")
            .eq("member_id", member_id) // ✅ فیلتر تنانت
            .order("code", { ascending: true })
            .limit(Number(limit));

        if (is_active === 'true') {
            query = query.eq("is_active", true);
        }

        if (tafsili_type) {
            query = query.eq("tafsili_type", tafsili_type);
        }

        if (exclude_types) {
            const types = exclude_types.split(',');
            query = query.not("tafsili_type", "in", `(${types.map(t => `"${t}"`).join(',')})`);
        }

        if (search) {
            query = query.or(`code.ilike.%${search}%,title.ilike.%${search}%`);
        }

        const { data, error } = await query;

        if (error) throw error;

        return res.json({ success: true, data });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* GET TAFSILI BY REF_ID */
router.get("/by-ref/:refId", authMiddleware, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from("accounting_tafsili")
            .select("id, code, title, tafsili_type")
            .eq("ref_id", req.params.refId)
            .eq("member_id", req.user.id) // ✅ فیلتر تنانت
            .single();

        if (error || !data) {
            return res.status(404).json({ success: false, error: "تفصیلی یافت نشد" });
        }

        return res.json({ success: true, data });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* GET ONE TAFSILI */
router.get("/:id", authMiddleware, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from("accounting_tafsili")
            .select("*")
            .eq("id", req.params.id)
            .eq("member_id", req.user.id) // ✅ فیلتر تنانت
            .single();

        if (error || !data) {
            return res.status(404).json({ success: false, error: "تفصیلی یافت نشد" });
        }

        return res.json({ success: true, data });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* CREATE TAFSILI */
router.post("/", authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.id;

        const payload = {
            ...req.body,
            member_id // ✅ تزریق خودکار
        };

        delete payload.id;
        delete payload.created_at;

        const { data, error } = await supabaseAdmin
            .from("accounting_tafsili")
            .insert([payload])
            .select()
            .single();

        if (error) throw error;

        return res.json({ success: true, data, message: "تفصیلی با موفقیت ایجاد شد" });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* UPDATE TAFSILI */
router.put("/:id", authMiddleware, async (req, res) => {
    try {
        const payload = { ...req.body };
        delete payload.id;
        delete payload.member_id; // ⚠️ جلوگیری از تغییر مالکیت
        delete payload.created_at;

        const { data, error } = await supabaseAdmin
            .from("accounting_tafsili")
            .update(payload)
            .eq("id", req.params.id)
            .eq("member_id", req.user.id) // ✅ فیلتر تنانت
            .select()
            .single();

        if (error || !data) {
            return res.status(404).json({
                success: false,
                error: "تفصیلی یافت نشد یا دسترسی ندارید"
            });
        }

        return res.json({ success: true, data, message: "تفصیلی با موفقیت ویرایش شد" });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* DELETE TAFSILI */
router.delete("/:id", authMiddleware, async (req, res) => {
    try {
        const { error } = await supabaseAdmin
            .from("accounting_tafsili")
            .delete()
            .eq("id", req.params.id)
            .eq("member_id", req.user.id); // ✅ فیلتر تنانت

        if (error) {
            if (error.code === '23503') {
                return res.status(409).json({
                    success: false,
                    error: "امکان حذف وجود ندارد (در اسناد استفاده شده)"
                });
            }
            throw error;
        }

        return res.json({ success: true, message: "تفصیلی با موفقیت حذف شد" });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;