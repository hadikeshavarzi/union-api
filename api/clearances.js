const express = require("express");
const { supabaseAdmin } = require("../supabaseAdmin");
const authMiddleware = require("./middleware/auth");

const router = express.Router();

/* ============================================================
   Helper: تبدیل UUID به عدد (حل مشکل 22P02)
============================================================ */
async function getNumericMemberId(idInput) {
    if (!idInput) return null;
    if (!isNaN(idInput) && !String(idInput).includes("-")) return Number(idInput);

    const { data, error } = await supabaseAdmin
        .from('members')
        .select('id')
        .eq('auth_user_id', idInput)
        .maybeSingle();

    if (error) {
        console.error("❌ Database Error in getNumericMemberId:", error.message);
        return null;
    }
    return data ? data.id : null;
}

/* ============================================================
   Helper: تولید شماره ترخیص اختصاصی
============================================================ */
async function generateClearanceNo(memberId) {
    const { count } = await supabaseAdmin
        .from("clearances")
        .select("*", { count: "exact", head: true })
        .eq("member_id", memberId);

    // فرمول: (آیدی انبار * 1000) + سری 200 + (تعداد + 1)
    return (memberId * 1000) + 200 + (count + 1);
}

/* ============================================================
   ۱. دریافت لیست کلی محصولات (موجودی لحظه‌ای و دقیق) ✅
============================================================ */
router.get("/owner-products/:ownerId", authMiddleware, async (req, res) => {
    try {
        const owner_id = Number(req.params.ownerId);
        const uuidOrId = req.user.id;
        let numericId = await getNumericMemberId(uuidOrId);
        if (!numericId) numericId = 2; // Fallback

        console.log(`🔍 Calculating Summary for Owner: ${owner_id}`);

        // الف) دریافت کل ورودی‌ها (از رسیدها)
        // نکته: Product را اینجا Join نمیکنیم تا ارور Embed ندهد
        const { data: receipts, error: rError } = await supabaseAdmin
            .from("receipt_items")
            .select(`product_id, count, weights_net, receipts!inner(owner_id, member_id)`)
            .eq("receipts.owner_id", owner_id)
            .eq("receipts.member_id", numericId);

        if (rError) throw rError;

        // ب) دریافت تمام تراکنش‌ها (هم مثبت هم منفی)
        const { data: transactions, error: tError } = await supabaseAdmin
            .from("inventory_transactions")
            .select("product_id, qty, weight")
            .eq("owner_id", owner_id)
            .eq("member_id", numericId);

        if (tError) throw tError;

        // ج) دریافت نام محصولات (کوئری جداگانه و ایمن)
        const productIds = [...new Set((receipts || []).map(r => r.product_id))];
        let productNames = {};

        if (productIds.length > 0) {
            const { data: productsData } = await supabaseAdmin
                .from("products")
                .select("id, name")
                .in("id", productIds);

            (productsData || []).forEach(p => { productNames[p.id] = p.name; });
        }

        // د) محاسبه مجموع
        const productMap = {};

        // 1. جمع ورودی‌ها
        (receipts || []).forEach(item => {
            const pid = item.product_id;
            if (!productMap[pid]) {
                productMap[pid] = {
                    id: pid,
                    title: productNames[pid] || 'کالای نامشخص',
                    qty: 0,
                    weight: 0
                };
            }
            productMap[pid].qty += Number(item.count || 0);
            productMap[pid].weight += Number(item.weights_net || 0);
        });

        // 2. اعمال تراکنش‌ها (جمع جبری: منفی‌ها خودکار کم می‌شوند)
        (transactions || []).forEach(item => {
            const pid = item.product_id;
            if (productMap[pid]) {
                productMap[pid].qty += Number(item.qty || 0);
                productMap[pid].weight += Number(item.weight || 0);
            }
        });

        // 3. فیلتر کردن و خروجی
        const summary = Object.values(productMap)
            .filter(p => p.qty > 0)
            .map(p => ({
                product_id: p.id,
                product_title: p.title,
                total_qty_available: p.qty,
                total_weight_available: p.weight
            }));

        return res.json({ success: true, data: summary });

    } catch (e) {
        console.error("❌ Owner Products Error:", e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   ۲. دریافت دسته‌های کالا (Batches) - دقیق‌ترین حالت ✅
============================================================ */
router.get("/batches", authMiddleware, async (req, res) => {
    try {
        const { owner_id, product_id } = req.query;
        let numericId = await getNumericMemberId(req.user.id);
        if (!numericId) numericId = 2;

        if (!owner_id || !product_id) {
            return res.status(400).json({ success: false, error: "Missing params" });
        }

        console.log(`📦 Fetching Batches for Product: ${product_id}`);

        // ۱. دریافت رسیدها (پایه موجودی)
        const { data: receiptItems, error: rError } = await supabaseAdmin
            .from("receipt_items")
            .select(`id, row_code, count, weights_net, receipts!inner (owner_id, member_id)`)
            .eq("receipts.owner_id", Number(owner_id))
            .eq("receipts.member_id", numericId)
            .eq("product_id", Number(product_id));

        if (rError) throw rError;

        // ۲. دریافت تمام تراکنش‌ها (بدون فیلتر منفی/مثبت)
        const { data: allTransactions, error: tError } = await supabaseAdmin
            .from("inventory_transactions")
            .select("*")
            .eq("owner_id", Number(owner_id))
            .eq("member_id", numericId)
            .eq("product_id", Number(product_id));

        if (tError) throw tError;

        const result = [];

        (receiptItems || []).forEach(receipt => {
            const batchName = receipt.row_code || `ID-${receipt.id}`;

            // موجودی اولیه
            let currentQty = Number(receipt.count || 0);
            let currentWeight = Number(receipt.weights_net || 0);

            // پیدا کردن تراکنش‌های مرتبط (خودش + فرزندانش)
            const relatedTx = (allTransactions || []).filter(tx =>
                tx.batch_no && (tx.batch_no === batchName || tx.batch_no.startsWith(batchName + '/'))
            );

            // ۳. اعمال تغییرات (جمع جبری)
            // منفی‌ها کم می‌شوند، مثبت‌ها زیاد می‌شوند
            relatedTx.forEach(tx => {
                currentQty += Number(tx.qty || 0);
                currentWeight += Number(tx.weight || 0);
            });

            console.log(`   👉 Batch ${batchName} -> Final Stock: ${currentQty}`);

            // فقط اگر موجودی دارد نشان بده
            if (currentQty > 0) {
                // آماده‌سازی تاریخچه برای نمایش درختی (تبدیل به مثبت برای نمایش زیبا)
                const history = relatedTx.map(tx => ({
                    ...tx,
                    display_qty: Math.abs(Number(tx.qty)), // فقط برای نمایش
                    display_weight: Math.abs(Number(tx.weight)),
                    qty: Number(tx.qty), // مقدار واقعی حفظ شود
                    weight: Number(tx.weight),
                    parent_batch_no: batchName
                }));

                result.push({
                    batch_no: batchName,
                    qty_available: currentQty,
                    weight_available: currentWeight,
                    history: history
                });
            }
        });

        return res.json({ success: true, data: result });

    } catch (e) {
        console.error("❌ Batch Error:", e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   ۳. ثبت ترخیص (POST) - همراه با سینک اتوماتیک ✅
============================================================ */
router.post("/", authMiddleware, async (req, res) => {
    try {
        const uuidOrId = req.user.id;
        let numericId = await getNumericMemberId(uuidOrId);
        if (!numericId) numericId = 2;

        const {
            customer_id, clearance_date, receiver_person_name, receiver_person_national_id,
            driver_name, plate, description, items, doc_type_id = 1
        } = req.body;

        const clearanceNo = await generateClearanceNo(numericId);

        // A. ثبت هدر
        const { data: clearance, error: hErr } = await supabaseAdmin
            .from("clearances")
            .insert({
                doc_type_id: doc_type_id,
                clearance_no: clearanceNo,
                member_id: numericId,
                status: 'final',
                clearance_date: clearance_date || new Date().toISOString(),
                customer_id: customer_id,
                receiver_person_name: receiver_person_name,
                receiver_person_national_id: receiver_person_national_id,
                driver_name: driver_name,
                vehicle_plate_iran_right: plate?.right2 || null,
                vehicle_plate_mid3: plate?.middle3 || null,
                vehicle_plate_letter: plate?.letter || null,
                vehicle_plate_left2: plate?.left2 || null,
                description: description
            })
            .select().single();

        if (hErr) {
            console.error("❌ Clearance Header Error:", hErr.message);
            return res.status(500).json({ success: false, error: hErr.message });
        }

        // B. ثبت آیتم‌ها
        const formattedItems = items.map(item => ({
            clearance_id: clearance.id,
            product_id: item.product_id,
            owner_id: customer_id,
            qty: Number(item.qty || 0),
            weight: Number(item.weight || 0),
            parent_batch_no: item.parent_batch_no || null,
            batch_no: item.batch_no || null,
            status: 'issued'
            // member_id را حذف کردیم چون ممکن است ستونش در دیتابیس شما نباشد
        }));

        const { error: iErr } = await supabaseAdmin.from("clearance_items").insert(formattedItems);

        if (iErr) {
            // Rollback
            await supabaseAdmin.from("clearances").delete().eq("id", clearance.id);
            console.error("❌ Clearance Items Error:", iErr.message);
            return res.status(500).json({ success: false, error: iErr.message });
        }

        // C. سینک موجودی (بسیار مهم)
        console.log(`🔄 Syncing Inventory for Clearance ID: ${clearance.id}`);
        const { error: rpcError } = await supabaseAdmin.rpc('sync_clearance_inventory', {
            p_clearance_id: clearance.id
        });

        if (rpcError) {
            console.error("❌ Inventory Sync Error:", rpcError.message);
        } else {
            console.log("✅ Inventory Synced Successfully!");
        }

        return res.json({
            success: true,
            clearance_no: clearanceNo,
            id: clearance.id,
            message: "سند ترخیص با موفقیت ثبت و موجودی کسر شد."
        });

    } catch (e) {
        console.error("❌ Server Error:", e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   ۴. گزارشات (GET)
============================================================ */
router.get("/report", authMiddleware, async (req, res) => {
    try {
        let numericId = await getNumericMemberId(req.user.id);
        if (!numericId) numericId = 2;

        const { data, error } = await supabaseAdmin
            .from("clearances")
            .select(`
                *,
                customer:customers (id, name),
                clearance_items ( *, product:products (id, name) )
            `)
            .eq("member_id", numericId)
            .order("clearance_date", { ascending: false });

        if (error) throw error;
        return res.json({ success: true, data });
    } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;