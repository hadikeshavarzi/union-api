// api/treasury/banks.js
const express = require("express");
const { supabaseAdmin } = require("../../supabaseAdmin");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

const pickPgErrorMessage = (err) =>
    err?.message || err?.details || err?.hint || err?.code || JSON.stringify(err);

/* GET ALL BANKS */
router.get("/", authMiddleware, async (req, res) => {
    try {
        const { limit = 100, offset = 0, search, with_tafsili } = req.query;
        const member_id = req.user.id;

        let selectQuery = with_tafsili === 'true'
            ? "*, accounting_tafsili(id, code, title)"
            : "*";

        let query = supabaseAdmin
            .from("treasury_banks")
            .select(selectQuery, { count: "exact" })
            .eq("member_id", member_id) // ✅ فیلتر تنانت
            .order("created_at", { ascending: false });

        if (search) {
            query = query.or(`bank_name.ilike.%${search}%,account_no.ilike.%${search}%,card_no.ilike.%${search}%`);
        }

        query = query.range(Number(offset), Number(offset) + Number(limit) - 1);

        const { data, error, count } = await query;

        if (error) {
            console.error("❌ GET Banks Error:", error);
            return res.status(400).json({ success: false, error: pickPgErrorMessage(error) });
        }

        return res.json({ success: true, data, total: count });
    } catch (e) {
        console.error("❌ Server Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* GET ONE BANK */
router.get("/:id", authMiddleware, async (req, res) => {
    try {
        const bank_id = Number(req.params.id);
        const member_id = req.user.id;

        const { data, error } = await supabaseAdmin
            .from("treasury_banks")
            .select("*, accounting_tafsili(id, code, title)")
            .eq("id", bank_id)
            .eq("member_id", member_id)
            .single();

        if (error || !data) {
            return res.status(404).json({
                success: false,
                error: "بانک یافت نشد یا دسترسی ندارید"
            });
        }

        return res.json({ success: true, data });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* CREATE BANK */
router.post("/", authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.id;

        console.log("🏦 Creating bank for member:", member_id);

        const payload = {
            ...req.body,
            member_id,
            tafsili_id: null
        };

        delete payload.id;
        delete payload.created_at;

        if (!payload.bank_name) {
            return res.status(400).json({
                success: false,
                error: "نام بانک الزامی است"
            });
        }

        // 1. ساخت بانک
        const { data: createdBank, error: bankError } = await supabaseAdmin
            .from("treasury_banks")
            .insert([payload])
            .select()
            .single();

        if (bankError) {
            console.error("❌ Bank Insert Error:", bankError);
            if (bankError.code === '23505') {
                return res.status(409).json({
                    success: false,
                    error: "اطلاعات تکراری است"
                });
            }
            throw bankError;
        }

        console.log("✅ Bank Created ID:", createdBank.id);

        // 2. ساخت حساب تفصیلی
        try {
            const nextCode = await generateNextTafsiliCode(member_id, 'bank_account');

            const tafsiliData = {
                code: nextCode,
                title: `${payload.bank_name} - ${payload.account_no || payload.card_no || 'بدون شماره'}`,
                tafsili_type: 'bank_account',
                ref_id: createdBank.id,
                member_id: member_id,
                is_active: true
            };

            console.log("💾 Inserting Tafsili for bank:", tafsiliData);

            const { data: createdTafsili, error: tafsiliError } = await supabaseAdmin
                .from("accounting_tafsili")
                .insert([tafsiliData])
                .select()
                .single();

            if (tafsiliError) {
                console.error("❌ Tafsili Insert Error:", tafsiliError);
                return res.json({
                    success: true,
                    data: createdBank,
                    warning: "بانک ثبت شد اما خطا در ساخت حساب تفصیلی رخ داد",
                    tafsiliError: tafsiliError.message
                });
            }

            console.log("✅ Tafsili Created ID:", createdTafsili.id);

            // 3. آپدیت بانک با tafsili_id
            const { error: updateError } = await supabaseAdmin
                .from("treasury_banks")
                .update({ tafsili_id: createdTafsili.id })
                .eq("id", createdBank.id);

            if (updateError) {
                console.error("❌ Update Bank Error:", updateError);
            } else {
                console.log("🔗 Linked Tafsili to Bank");
                createdBank.tafsili_id = createdTafsili.id;
            }
        } catch (tafsiliErr) {
            console.error("⚠️ Tafsili creation failed:", tafsiliErr);
        }

        return res.json({
            success: true,
            data: createdBank,
            message: "بانک با موفقیت ایجاد شد"
        });
    } catch (e) {
        console.error("❌ Server Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* UPDATE BANK */
router.put("/:id", authMiddleware, async (req, res) => {
    try {
        const bank_id = Number(req.params.id);
        const member_id = req.user.id;

        const { data: existing } = await supabaseAdmin
            .from("treasury_banks")
            .select("id, tafsili_id")
            .eq("id", bank_id)
            .eq("member_id", member_id)
            .single();

        if (!existing) {
            return res.status(404).json({
                success: false,
                error: "بانک یافت نشد یا دسترسی ندارید"
            });
        }

        const payload = { ...req.body };
        delete payload.id;
        delete payload.member_id;
        delete payload.created_at;
        delete payload.tafsili_id;

        const { data, error } = await supabaseAdmin
            .from("treasury_banks")
            .update(payload)
            .eq("id", bank_id)
            .eq("member_id", member_id)
            .select()
            .single();

        if (error) {
            console.error("❌ Update Bank Error:", error);
            return res.status(400).json({
                success: false,
                error: pickPgErrorMessage(error)
            });
        }

        // آپدیت نام تفصیلی
        if ((payload.bank_name || payload.account_no) && existing.tafsili_id) {
            const newTitle = `${data.bank_name} - ${data.account_no || data.card_no || 'بدون شماره'}`;

            await supabaseAdmin
                .from("accounting_tafsili")
                .update({ title: newTitle })
                .eq("id", existing.tafsili_id);
        }

        return res.json({
            success: true,
            data,
            message: "بانک با موفقیت ویرایش شد"
        });
    } catch (e) {
        console.error("❌ Server Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* DELETE BANK */
router.delete("/:id", authMiddleware, async (req, res) => {
    try {
        const bank_id = Number(req.params.id);
        const member_id = req.user.id;

        const { data: bank } = await supabaseAdmin
            .from("treasury_banks")
            .select("id, tafsili_id")
            .eq("id", bank_id)
            .eq("member_id", member_id)
            .single();

        if (!bank) {
            return res.status(404).json({
                success: false,
                error: "بانک یافت نشد یا دسترسی ندارید"
            });
        }

        const { error } = await supabaseAdmin
            .from("treasury_banks")
            .delete()
            .eq("id", bank_id)
            .eq("member_id", member_id);

        if (error) {
            if (error.code === '23503') {
                return res.status(409).json({
                    success: false,
                    error: "امکان حذف وجود ندارد (بانک در تراکنش‌ها استفاده شده)"
                });
            }
            throw error;
        }

        // حذف تفصیلی
        if (bank.tafsili_id) {
            await supabaseAdmin
                .from("accounting_tafsili")
                .delete()
                .eq("id", bank.tafsili_id);
        }

        return res.json({
            success: true,
            message: "بانک با موفقیت حذف شد"
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* Helper: تولید کد تفصیلی */
async function generateNextTafsiliCode(memberId, type = 'bank_account') {
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
        console.error("❌ Code Gen Error:", e);
        return "0001";
    }
}

module.exports = router;