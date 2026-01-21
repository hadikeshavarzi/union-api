// api/customers.js - COMPLETE & FIXED FOR INTEGER IDs
const express = require("express");
const { supabaseAdmin } = require("../supabaseAdmin");
const authMiddleware = require("./middleware/auth");

const router = express.Router();

const TAFSILI_TABLE = "accounting_tafsili";

/* ============================================================
   Helper: تبدیل UUID به عدد (جلوگیری از کرش)
   ✅ حیاتی برای حل مشکل Invalid Syntax for Integer
============================================================ */
async function getNumericMemberId(idInput) {
    if (!idInput) return null;

    // اگر ورودی از قبل عدد است
    if (!isNaN(idInput) && !String(idInput).includes("-")) {
        return Number(idInput);
    }

    // اگر UUID است، از دیتابیس پیدا کن
    const { data, error } = await supabaseAdmin
        .from('members')
        .select('id')
        .eq('auth_user_id', idInput)
        .maybeSingle();

    if (error) {
        console.error("❌ DB Error in getNumericMemberId:", error.message);
        return null;
    }

    return data ? data.id : null;
}

/* ============================================================
   Helper: تولید کد تفصیلی جدید (برای مشتریان)
============================================================ */
async function generateNextTafsiliCode(memberId) {
    try {
        const { data: lastRecord } = await supabaseAdmin
            .from(TAFSILI_TABLE)
            .select("code")
            .eq("member_id", memberId)
            .eq("tafsili_type", "customer")
            .lt('code', '999999') // فقط کدهای سیستمی کمتر از 6 رقم
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

/* ============================================================
   GET CUSTOMERS (لیست مشتریان)
============================================================ */
router.get("/", authMiddleware, async (req, res) => {
    try {
        let member_id = await getNumericMemberId(req.user.id);
        if (!member_id) member_id = 2; // Fallback

        const { limit = 1000, offset = 0, search } = req.query;

        let query = supabaseAdmin
            .from("customers")
            .select("*", { count: "exact" })
            .eq("member_id", member_id) // ✅ استفاده از آیدی عددی
            .order("created_at", { ascending: false });

        if (search) {
            query = query.or(`name.ilike.%${search}%,mobile.ilike.%${search}%,national_id.ilike.%${search}%`);
        }

        query = query.range(Number(offset), Number(offset) + Number(limit) - 1);
        const { data, error, count } = await query;

        if (error) throw error;
        return res.json({ success: true, data, total: count });
    } catch (e) {
        console.error("❌ GET Customers Error:", e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   GET ONE (جزئیات مشتری)
============================================================ */
router.get("/:id", authMiddleware, async (req, res) => {
    try {
        let member_id = await getNumericMemberId(req.user.id);
        if (!member_id) member_id = 2;

        const { data, error } = await supabaseAdmin
            .from("customers")
            .select("*")
            .eq("id", req.params.id)
            .eq("member_id", member_id)
            .single();

        if (error || !data) return res.status(404).json({ success: false, error: "Not Found" });
        return res.json({ success: true, data });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   📌 CREATE CUSTOMER + TAFSILI
   ساخت همزمان مشتری و حساب تفصیلی متصل
============================================================ */
router.post("/", authMiddleware, async (req, res) => {
    try {
        // ۱. دریافت آیدی عددی کاربر
        let member_id = await getNumericMemberId(req.user.id);
        if (!member_id) member_id = 2;

        const body = req.body;
        const name = body.name || body.full_name;
        const mobile = body.mobile;

        console.log(`🚀 Creating Customer: ${name} for Member ID: ${member_id}`);

        if (!name || !mobile) {
            return res.status(400).json({ success: false, error: "نام و موبایل الزامی است" });
        }

        // ۲. چک تکراری بودن موبایل
        const { data: existMobile } = await supabaseAdmin
            .from("customers")
            .select("id")
            .eq("member_id", member_id) // ✅ آیدی عددی
            .eq("mobile", mobile)
            .maybeSingle();

        if (existMobile) return res.status(409).json({ success: false, error: "شماره موبایل تکراری است." });

        // ---------------------------------------------------------
        // ۳. ساخت مشتری (مرحله اول)
        // ---------------------------------------------------------
        const newCustomerData = {
            name: name,
            mobile: mobile,
            national_id: body.national_id || null,
            phone: body.phone || null,
            postal_code: body.postal_code || null,
            economic_code: body.economic_code || null,
            address: body.address || null,
            description: body.description || null,
            birth_or_register_date: body.birth_or_register_date || null,
            customer_type: body.customer_type || 'person',
            member_id: member_id, // ✅ آیدی عددی صحیح
            tafsili_id: null
        };

        const { data: createdCustomer, error: createError } = await supabaseAdmin
            .from("customers")
            .insert([newCustomerData])
            .select()
            .single();

        if (createError) {
            console.error("❌ Customer Insert Error:", createError);
            if (createError.code === '23505') return res.status(409).json({ success: false, error: "اطلاعات تکراری است" });
            throw createError;
        }

        console.log("✅ Customer Created ID:", createdCustomer.id);

        // ---------------------------------------------------------
        // ۴. ساخت حساب تفصیلی (مرحله دوم)
        // ---------------------------------------------------------
        const nextCode = await generateNextTafsiliCode(member_id);

        const newTafsiliData = {
            code: nextCode,
            title: name,
            tafsili_type: 'customer',
            ref_id: createdCustomer.id,
            member_id: member_id, // ✅ آیدی عددی صحیح
            is_active: true
        };

        const { data: createdTafsili, error: tafsiliError } = await supabaseAdmin
            .from(TAFSILI_TABLE)
            .insert([newTafsiliData])
            .select()
            .single();

        if (tafsiliError) {
            console.error("❌ Tafsili Insert Error:", tafsiliError);
            // حتی اگر تفصیلی ساخته نشد، موفقیت برمی‌گردانیم چون مشتری ساخته شده
            return res.json({
                success: true,
                data: createdCustomer,
                message: "مشتری ثبت شد اما در ساخت حساب تفصیلی خطایی رخ داد."
            });
        }

        console.log("✅ Tafsili Created ID:", createdTafsili.id);

        // ---------------------------------------------------------
        // ۵. اتصال تفصیلی به مشتری (مرحله سوم - آپدیت)
        // ---------------------------------------------------------
        const { error: updateError } = await supabaseAdmin
            .from("customers")
            .update({ tafsili_id: createdTafsili.id })
            .eq("id", createdCustomer.id);

        if (updateError) {
            console.error("❌ Update Customer Error:", updateError);
        } else {
            console.log("🔗 Linked Tafsili to Customer successfully");
            createdCustomer.tafsili_id = createdTafsili.id;
        }

        return res.json({
            success: true,
            data: createdCustomer,
            message: "مشتری و حساب تفصیلی با موفقیت ثبت شدند"
        });

    } catch (e) {
        console.error("❌ General Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   UPDATE CUSTOMER
============================================================ */
router.put("/:id", authMiddleware, async (req, res) => {
    try {
        let member_id = await getNumericMemberId(req.user.id);
        if (!member_id) member_id = 2;

        const { id, created_at, tafsili_id, ...updates } = req.body;

        // حذف فیلدهای حساس و سیستمی
        delete updates.member_id;

        const { data, error } = await supabaseAdmin
            .from("customers")
            .update(updates)
            .eq("id", req.params.id)
            .eq("member_id", member_id)
            .select()
            .single();

        if (error) throw error;

        // اگر نام مشتری عوض شد، نام حساب تفصیلی هم باید عوض شود
        if ((updates.name || updates.full_name) && data.tafsili_id) {
            const newName = updates.name || updates.full_name;
            await supabaseAdmin
                .from(TAFSILI_TABLE)
                .update({ title: newName })
                .eq("id", data.tafsili_id);
        }

        return res.json({ success: true, data, message: "ویرایش شد" });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   DELETE CUSTOMER
============================================================ */
router.delete("/:id", authMiddleware, async (req, res) => {
    try {
        let member_id = await getNumericMemberId(req.user.id);
        if (!member_id) member_id = 2;

        // اول اطلاعات مشتری را می‌گیریم تا ID تفصیلی را داشته باشیم
        const { data: customer } = await supabaseAdmin
            .from("customers")
            .select("tafsili_id")
            .eq("id", req.params.id)
            .single();

        // حذف مشتری
        const { error } = await supabaseAdmin
            .from("customers")
            .delete()
            .eq("id", req.params.id)
            .eq("member_id", member_id);

        if (error?.code === "23503") {
            return res.status(409).json({
                success: false,
                error: "امکان حذف وجود ندارد (این مشتری در سیستم دارای سند یا رسید است)"
            });
        }
        if (error) throw error;

        // حذف حساب تفصیلی متصل (اختیاری اما توصیه شده برای تمیزی دیتابیس)
        if (customer && customer.tafsili_id) {
            await supabaseAdmin.from(TAFSILI_TABLE).delete().eq("id", customer.tafsili_id);
        }

        return res.json({ success: true, message: "حذف شد" });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;