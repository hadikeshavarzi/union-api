// api/treasury/pos.js
const express = require("express");
const { supabaseAdmin } = require("../../supabaseAdmin");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

/* GET ALL POS */
router.get("/", authMiddleware, async (req, res) => {
    try {
        const { with_bank, with_tafsili } = req.query;
        const member_id = req.user.id;

        let selectQuery = "*";

        if (with_bank === 'true') {
            selectQuery += ", treasury_banks(id, bank_name, account_no)";
        }

        if (with_tafsili === 'true') {
            selectQuery += ", accounting_tafsili(id, code, title)";
        }

        const { data, error } = await supabaseAdmin
            .from("treasury_pos")
            .select(selectQuery)
            .eq("member_id", member_id) // ✅ فیلتر تنانت
            .order("created_at", { ascending: false });

        if (error) throw error;

        return res.json({ success: true, data });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* GET ONE POS */
router.get("/:id", authMiddleware, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from("treasury_pos")
            .select(`
                *,
                treasury_banks(id, bank_name, account_no),
                accounting_tafsili(id, code, title)
            `)
            .eq("id", req.params.id)
            .eq("member_id", req.user.id)
            .single();

        if (error || !data) {
            return res.status(404).json({
                success: false,
                error: "POS یافت نشد یا دسترسی ندارید"
            });
        }

        return res.json({ success: true, data });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* CREATE POS */
router.post("/", authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.id;

        const payload = {
            ...req.body,
            member_id,
            tafsili_id: null
        };

        delete payload.id;
        delete payload.created_at;

        if (!payload.title || !payload.bank_id) {
            return res.status(400).json({
                success: false,
                error: "عنوان و حساب متصل الزامی است"
            });
        }

        // چک اینکه bank_id متعلق به این member باشه
        const { data: bank } = await supabaseAdmin
            .from("treasury_banks")
            .select("id")
            .eq("id", payload.bank_id)
            .eq("member_id", member_id)
            .single();

        if (!bank) {
            return res.status(403).json({
                success: false,
                error: "بانک انتخابی یافت نشد یا دسترسی ندارید"
            });
        }

        // 1. ساخت POS
        const { data: createdPos, error: posError } = await supabaseAdmin
            .from("treasury_pos")
            .insert([payload])
            .select()
            .single();

        if (posError) throw posError;

        // 2. ساخت تفصیلی
        try {
            const nextCode = await generateNextTafsiliCode(member_id, 'pos');

            const tafsiliData = {
                code: nextCode,
                title: payload.title,
                tafsili_type: 'pos',
                ref_id: createdPos.id,
                member_id: member_id,
                is_active: true
            };

            const { data: createdTafsili, error: tafsiliError } = await supabaseAdmin
                .from("accounting_tafsili")
                .insert([tafsiliData])
                .select()
                .single();

            if (!tafsiliError) {
                await supabaseAdmin
                    .from("treasury_pos")
                    .update({ tafsili_id: createdTafsili.id })
                    .eq("id", createdPos.id);

                createdPos.tafsili_id = createdTafsili.id;
            }
        } catch (e) {
            console.error("⚠️ Tafsili creation failed:", e);
        }

        return res.json({
            success: true,
            data: createdPos,
            message: "POS با موفقیت ایجاد شد"
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* UPDATE POS */
router.put("/:id", authMiddleware, async (req, res) => {
    try {
        const pos_id = Number(req.params.id);
        const member_id = req.user.id;

        const { data: existing } = await supabaseAdmin
            .from("treasury_pos")
            .select("id, tafsili_id")
            .eq("id", pos_id)
            .eq("member_id", member_id)
            .single();

        if (!existing) {
            return res.status(404).json({
                success: false,
                error: "POS یافت نشد یا دسترسی ندارید"
            });
        }

        const payload = { ...req.body };
        delete payload.id;
        delete payload.member_id;
        delete payload.created_at;
        delete payload.tafsili_id;

        const { data, error } = await supabaseAdmin
            .from("treasury_pos")
            .update(payload)
            .eq("id", pos_id)
            .eq("member_id", member_id)
            .select()
            .single();

        if (error) throw error;

        // آپدیت تفصیلی
        if (payload.title && existing.tafsili_id) {
            await supabaseAdmin
                .from("accounting_tafsili")
                .update({ title: payload.title })
                .eq("id", existing.tafsili_id);
        }

        return res.json({
            success: true,
            data,
            message: "POS با موفقیت ویرایش شد"
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* DELETE POS */
router.delete("/:id", authMiddleware, async (req, res) => {
    try {
        const pos_id = Number(req.params.id);
        const member_id = req.user.id;

        const { data: pos } = await supabaseAdmin
            .from("treasury_pos")
            .select("id, tafsili_id")
            .eq("id", pos_id)
            .eq("member_id", member_id)
            .single();

        if (!pos) {
            return res.status(404).json({
                success: false,
                error: "POS یافت نشد یا دسترسی ندارید"
            });
        }

        const { error } = await supabaseAdmin
            .from("treasury_pos")
            .delete()
            .eq("id", pos_id)
            .eq("member_id", member_id);

        if (error) {
            if (error.code === '23503') {
                return res.status(409).json({
                    success: false,
                    error: "امکان حذف وجود ندارد (POS در تراکنش‌ها استفاده شده)"
                });
            }
            throw error;
        }

        // حذف تفصیلی
        if (pos.tafsili_id) {
            await supabaseAdmin
                .from("accounting_tafsili")
                .delete()
                .eq("id", pos.tafsili_id);
        }

        return res.json({
            success: true,
            message: "POS با موفقیت حذف شد"
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

async function generateNextTafsiliCode(memberId, type) {
    try {
        const { data: lastRecord } = await supabaseAdmin
            .from("accounting_tafsili")
            .select("code")
            .eq("member_id", memberId)
            .eq("tafsili_type", type)
            .lt('code', '999999')
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        let nextNum = 1;
        if (lastRecord && lastRecord.code && !isNaN(Number(lastRecord.code))) {
            nextNum = Number(lastRecord.code) + 1;
        }

        return String(nextNum).padStart(4, "0");
    } catch (e) {
        return "0001";
    }
}

module.exports = router;