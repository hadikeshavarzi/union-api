const express = require("express");
const { supabaseAdmin } = require("../../supabaseAdmin");
const authMiddleware = require("../middleware/auth");
const { generateDocNo, getNumericMemberId, findMoeinIdByCode } = require("./helpers");

const router = express.Router();

router.post("/register-exit-doc", authMiddleware, async (req, res) => {
    try {
        const { exit_id } = req.body;
        const targetExitId = exit_id || req.body.exitId;

        if (!targetExitId) return res.status(400).json({ success: false, error: "شناسه خروج ارسال نشده است." });

        let numericId = await getNumericMemberId(req.user.id);
        if (!numericId) numericId = 2;

        // 1. دریافت سند خروج
        const { data: exitRecord, error: exitErr } = await supabaseAdmin
            .from("warehouse_exits").select("*").eq("id", targetExitId).single();

        if (exitErr || !exitRecord) return res.status(404).json({ success: false, error: "سند خروج یافت نشد." });

        if (exitRecord.accounting_doc_id) {
            return res.json({ success: true, doc_id: exitRecord.accounting_doc_id, message: "سند قبلاً صادر شده است." });
        }

        // محاسبه مجموع کل بدهی
        const totalAmount = Number(exitRecord.total_fee || 0) +
            Number(exitRecord.total_loading_fee || 0) +
            Number(exitRecord.weighbridge_fee || 0) +
            Number(exitRecord.extra_fee || 0) +
            Number(exitRecord.vat_fee || 0);

        if (totalAmount <= 0) return res.json({ success: true, message: "مبلغ صفر است، سند صادر نشد." });

        // ==========================================
        //  الف) آماده‌سازی سمت بدهکار (Debtor)
        // ==========================================
        let debtorEntry = null;

        if (exitRecord.payment_method === 'credit') {
            // --- نسیه (بدهکار: مشتری - کد 10301) ---
            const moeinId = await findMoeinIdByCode("10301");
            if (!exitRecord.owner_id) return res.status(400).json({ success: false, error: "صاحب کالا مشخص نیست." });

            const { data: customer } = await supabaseAdmin.from("customers").select("tafsili_id, name").eq("id", exitRecord.owner_id).single();
            if (!customer?.tafsili_id) return res.status(400).json({ success: false, error: "حساب تفصیلی مشتری یافت نشد." });

            debtorEntry = {
                moein_id: moeinId,
                tafsili_id: customer.tafsili_id,
                bed: totalAmount,
                bes: 0,
                description: `بابت خدمات خروج شماره ${exitRecord.exit_no}` // طبق دیتای شما
            };

        } else {
            // --- نقدی/کارتخوان (بدهکار: صندوق 10101 / کارتخوان 10104) ---
            const tafsiliId = exitRecord.financial_account_id;
            if (!tafsiliId) return res.status(400).json({ success: false, error: "حساب بانک/صندوق انتخاب نشده." });

            let moeinCode = "10103"; // پیش‌فرض بانک
            if (exitRecord.payment_method === 'cash') moeinCode = "10101"; // صندوق
            else if (exitRecord.payment_method === 'pos') moeinCode = "10104"; // موجودی نزد کارتخوان (طبق دیتای شما)

            const moeinId = await findMoeinIdByCode(moeinCode);

            debtorEntry = {
                moein_id: moeinId,
                tafsili_id: tafsiliId,
                bed: totalAmount,
                bes: 0,
                description: `دریافت وجه بابت خروج ${exitRecord.exit_no}`
            };
        }

        // ==========================================
        //  ب) آماده‌سازی سمت بستانکار (Creditors - Split)
        //  طبق دیتای شما باید تفکیک شود
        // ==========================================
        const creditorEntries = [];

        // 1. درآمد انبارداری (کد 60101 - معین ۱۰)
        if (Number(exitRecord.total_fee) > 0) {
            const mId = await findMoeinIdByCode("60101");
            creditorEntries.push({
                moein_id: mId,
                tafsili_id: null,
                bed: 0,
                bes: Number(exitRecord.total_fee),
                description: "درآمد انبارداری"
            });
        }

        // 2. درآمد بارگیری (کد 60102 - معین ۱۱)
        if (Number(exitRecord.total_loading_fee) > 0) {
            const mId = await findMoeinIdByCode("60102");
            creditorEntries.push({
                moein_id: mId,
                tafsili_id: null,
                bed: 0,
                bes: Number(exitRecord.total_loading_fee),
                description: "درآمد بارگیری"
            });
        }

        // 3. درآمد باسکول (کد 60103 - معین ۱۲)
        if (Number(exitRecord.weighbridge_fee) > 0) {
            const mId = await findMoeinIdByCode("60103");
            creditorEntries.push({
                moein_id: mId,
                tafsili_id: null,
                bed: 0,
                bes: Number(exitRecord.weighbridge_fee),
                description: "درآمد باسکول"
            });
        }

        // 4. سایر درآمدها (کد 60104 - معین ۱۳)
        if (Number(exitRecord.extra_fee) > 0) {
            const mId = await findMoeinIdByCode("60104");
            creditorEntries.push({
                moein_id: mId,
                tafsili_id: null,
                bed: 0,
                bes: Number(exitRecord.extra_fee),
                description: "سایر درآمدهای عملیاتی"
            });
        }

        // 5. مالیات بر ارزش افزوده (کد 30201 - معین ۸)
        if (Number(exitRecord.vat_fee) > 0) {
            const mId = await findMoeinIdByCode("30201");
            creditorEntries.push({
                moein_id: mId,
                tafsili_id: null,
                bed: 0,
                bes: Number(exitRecord.vat_fee),
                description: "مالیات بر ارزش افزوده"
            });
        }

        // ==========================================
        //  ج) ثبت نهایی در دیتابیس
        // ==========================================

        // 1. ثبت هدر سند
        const docNo = await generateDocNo(numericId);
        const docDate = exitRecord.exit_date || new Date().toISOString();

        const { data: finDoc, error: docErr } = await supabaseAdmin
            .from("financial_documents")
            .insert({
                member_id: numericId,
                doc_no: docNo,
                doc_date: docDate,
                description: `بابت خدمات خروج شماره ${exitRecord.exit_no} - ${exitRecord.driver_name}`,
                status: 'confirmed',
                doc_type: 'auto'
            })
            .select().single();

        if (docErr) throw docErr;

        // 2. آماده‌سازی آرایه نهایی برای اینسرت
        const finalEntries = [debtorEntry, ...creditorEntries].map(entry => ({
            doc_id: finDoc.id,       // ✅ اتصال به هدر
            member_id: numericId,    // ✅ شناسه ممبر
            moein_id: entry.moein_id,
            tafsili_id: entry.tafsili_id,
            bed: entry.bed,
            bes: entry.bes,
            description: entry.description
        }));

        // 3. اینسرت آرتیکل‌ها
        const { error: entryErr } = await supabaseAdmin.from("financial_entries").insert(finalEntries);

        if (entryErr) {
            await supabaseAdmin.from("financial_documents").delete().eq("id", finDoc.id);
            throw entryErr;
        }

        // 4. آپدیت خروجی
        await supabaseAdmin.from("warehouse_exits").update({ accounting_doc_id: finDoc.id }).eq("id", targetExitId);

        return res.json({ success: true, doc_id: finDoc.id, doc_no: docNo, message: "سند حسابداری با ریز اقلام صادر شد." });

    } catch (e) {
        console.error("❌ Register Doc Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;