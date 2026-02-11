/**
 * api/accounting/accountingAuto.js
 */

const MOEIN = {
    CASH:                 "fcad560f-ae49-10bf-48dd-6a865e5f558b", // 10101 - موجودی نقد
    BANK:                 "26fd8975-3b2a-02c9-e574-7c1cbb871f0b", // 10103 - موجودی بانک
    POS:                  "2b20175e-944b-b5e9-1b8c-aab56bd0b918", // 10104 - دستگاه پوز
    CUSTOMERS_RECEIVABLE: "55b25abe-a385-fcea-5f4f-951293860337", // 10301 - حساب‌های دریافتنی تجاری
    VAT:                  "6bbf21a7-f4aa-949f-a0dd-033e50e7dada", // 30201 - مالیات بر ارزش افزوده
    INCOME_WAREHOUSE:     "ad0efd2f-fe61-2f49-688a-aa86b1166f99", // 60101 - درآمد انبارداری
    INCOME_LOADING:       "8da3a452-1d4c-ca83-4fcd-029ed3843231", // 60102 - درآمد تخلیه و بارگیری
    INCOME_OTHER:         "e7f9461b-61c5-1b99-a7fb-e477ad801de6", // 60104 - سایر درآمدها
};

const COST_MAP = [
    { field: "warehouseCost", moein: MOEIN.INCOME_WAREHOUSE, label: "انبارداری" },
    { field: "loadingFee",    moein: MOEIN.INCOME_LOADING,   label: "بارگیری" },
    { field: "unloadCost",    moein: MOEIN.INCOME_LOADING,   label: "تخلیه" },
    { field: "loadCost",      moein: MOEIN.INCOME_OTHER,     label: "کرایه حمل" },
    { field: "tax",           moein: MOEIN.VAT,              label: "مالیات" },
    { field: "returnFreight", moein: MOEIN.INCOME_OTHER,     label: "کرایه برگشت" },
    { field: "miscCost",      moein: MOEIN.INCOME_OTHER,     label: "سایر" },
];

async function generateReceiptAccounting(client, opts) {
    const { receiptId, receiptNo, memberId, ownerId, docDate,
            paymentBy, paymentSourceId, paymentSourceType } = opts;

    // ── ۱. تفکیک ریز هزینه‌ها (بدون تجمیع) ──
    const detailedCosts = [];
    let totalAmount = 0;

    for (const m of COST_MAP) {
        const amount = Number(opts[m.field]) || 0;
        if (amount > 0) {
            totalAmount += amount;
            detailedCosts.push({
                moein: m.moein,
                amount: amount,
                label: m.label
            });
        }
    }

    if (totalAmount <= 0) return null;

    // ── ۲. استخراج تفصیلی مشتری ──
    let customerTafsiliId = null;
    let customerName = "مشتری";

    if (ownerId) {
        const custRes = await client.query(`SELECT tafsili_id, name FROM public.customers WHERE id = $1`, [ownerId]);
        if (custRes.rows.length > 0) {
            customerTafsiliId = custRes.rows[0].tafsili_id;
            customerName = custRes.rows[0].name;

            if (!customerTafsiliId) {
                const lastRes = await client.query(
                    `SELECT code FROM public.accounting_tafsili WHERE member_id=$1 AND tafsili_type='customer' ORDER BY code DESC LIMIT 1`, [memberId]);
                const newCode = String((parseInt(lastRes.rows[0]?.code || "0") || 0) + 1).padStart(4, "0");

                const ins = await client.query(`
                    INSERT INTO public.accounting_tafsili (code, title, tafsili_type, ref_id, is_active, member_id, created_at, updated_at)
                    VALUES ($1, $2, 'customer', $3, true, $4, NOW(), NOW()) RETURNING id`, 
                    [newCode, customerName, ownerId, memberId]);
                
                customerTafsiliId = ins.rows[0].id;
                await client.query(`UPDATE public.customers SET tafsili_id=$1 WHERE id=$2`, [customerTafsiliId, ownerId]);
            }
        }
    }

    // ── ۳. استخراج تفصیلی منبع پرداخت (بانک / صندوق / پوز) ──
    let sourceTafsiliId = null;
    let sourceMoein = MOEIN.CASH;

    const pType = (paymentSourceType || "").toLowerCase().trim();

    if (paymentBy === "warehouse" && paymentSourceId) {
        console.log(`🔍 منبع پرداخت: type="${pType}" id="${paymentSourceId}"`);

        // تعیین جدول و معین بر اساس نوع
        let sourceTable;
        if (pType === "bank") {
            sourceTable = "treasury_banks";
            sourceMoein = MOEIN.BANK;
        } else if (pType === "pos") {
            sourceTable = "treasury_banks";
            sourceMoein = MOEIN.POS;
        } else {
            sourceTable = "treasury_cashes";
            sourceMoein = MOEIN.CASH;
        }

        // واکشی تفصیلی از جدول اصلی
        const sourceRes = await client.query(
            `SELECT tafsili_id FROM public.${sourceTable} WHERE id = $1`, [paymentSourceId]);
        sourceTafsiliId = sourceRes.rows[0]?.tafsili_id || null;

        // اگه پیدا نشد، جدول دیگه رو هم چک کن (فالبک)
        if (!sourceTafsiliId && sourceRes.rows.length === 0) {
            const altTable = sourceTable === "treasury_banks" ? "treasury_cashes" : "treasury_banks";
            const altRes = await client.query(
                `SELECT tafsili_id FROM public.${altTable} WHERE id = $1`, [paymentSourceId]);
            if (altRes.rows.length > 0) {
                sourceTafsiliId = altRes.rows[0]?.tafsili_id || null;
                sourceMoein = altTable === "treasury_banks" ? MOEIN.BANK : MOEIN.CASH;
                console.log(`🔍 فالبک: پیدا شد در ${altTable}`);
            }
        }

        console.log(`🔍 تفصیلی منبع: ${sourceTafsiliId || "NULL"} | معین: ${sourceMoein}`);
    }

    // ── ۴. هدر سند ──
    const maxRes = await client.query(
        `SELECT COALESCE(MAX(doc_no),0) as n FROM public.financial_documents WHERE member_id=$1`, [memberId]);
    const nextDocNo = Number(maxRes.rows[0].n) + 1;

    const itemNames = detailedCosts.map(x => x.label).join('، ');
    const docDescription = paymentBy === "warehouse" 
        ? `پرداخت توسط انبار بابت رسید ${receiptNo} (${itemNames})`
        : `درآمد رسید ${receiptNo} (${itemNames})`;

    const docRes = await client.query(`
        INSERT INTO public.financial_documents
            (member_id, doc_no, doc_date, description, status, doc_type, reference_id, reference_type, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW()) RETURNING id, doc_no`,
        [memberId, nextDocNo, docDate, docDescription, "confirmed", "auto_receipt", receiptId, "receipt"]);

    const docId = docRes.rows[0].id;
    const docNo = docRes.rows[0].doc_no;

    // ── ۵. ثبت آرتیکل‌ها ──
    const entries = [];

    if (paymentBy === "warehouse") {
        // پرداخت توسط انبار:
        // بدهکار: مشتری (ریز به ریز)
        // بستانکار: بانک/صندوق (یکجا)

        for (const item of detailedCosts) {
            entries.push({
                moein: MOEIN.CUSTOMERS_RECEIVABLE,
                tafsili: customerTafsiliId,
                bed: item.amount,
                bes: 0,
                desc: `بدهکاری بابت ${item.label} - رسید ${receiptNo}`
            });
        }

        entries.push({
            moein: sourceMoein,
            tafsili: sourceTafsiliId,
            bed: 0,
            bes: totalAmount,
            desc: `خروج وجه بابت رسید ${receiptNo} - طرف حساب: ${customerName}`
        });

    } else {
        // مشتری (نسیه):
        // بدهکار: مشتری (یکجا)
        // بستانکار: درآمدها (ریز به ریز)

        entries.push({
            moein: MOEIN.CUSTOMERS_RECEIVABLE,
            tafsili: customerTafsiliId,
            bed: totalAmount,
            bes: 0,
            desc: `بدهکاری بابت خدمات رسید ${receiptNo}`
        });

        for (const item of detailedCosts) {
            entries.push({
                moein: item.moein,
                tafsili: null, 
                bed: 0,
                bes: item.amount,
                desc: `${item.label} - رسید ${receiptNo}`
            });
        }
    }

    // ── ۶. ذخیره نهایی ──
    const sumBed = entries.reduce((s, e) => s + e.bed, 0);
    const sumBes = entries.reduce((s, e) => s + e.bes, 0);

    if (Math.abs(sumBed - sumBes) > 1) {
        throw new Error(`عدم تراز: بدهکار=${sumBed} بستانکار=${sumBes}`);
    }

    for (const e of entries) {
        await client.query(`
            INSERT INTO public.financial_entries 
                (doc_id, member_id, moein_id, tafsili_id, bed, bes, description, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`, 
            [docId, memberId, e.moein, e.tafsili, e.bed, e.bes, e.desc]);
    }

    return { docId, docNo, entriesCount: entries.length, totalAmount };
}

module.exports = { generateReceiptAccounting };