const express = require("express");
const { supabaseAdmin } = require("../supabaseAdmin");
const authMiddleware = require("./middleware/auth");

const router = express.Router();

// --- Helper: دریافت آیدی عددی ممبر ---
async function getNumericMemberId(idInput) {
    if (!idInput) return null;
    if (!isNaN(idInput) && !String(idInput).includes("-")) return Number(idInput);
    const { data } = await supabaseAdmin.from('members').select('id').eq('auth_user_id', idInput).maybeSingle();
    return data ? data.id : null;
}

// --- Helper: تولید شماره خروج ---
async function generateExitNo(memberId) {
    const { count } = await supabaseAdmin.from("warehouse_exits").select("*", { count: "exact", head: true }).eq("member_id", memberId);
    return (Number(memberId) * 1000) + 9000 + (count + 1);
}

// ============================================================
//  1. دریافت لیست کامل خروجی‌ها (مخصوص صفحه لیست) - ✅ اضافه شد
//  GET /api/exits
// ============================================================
// در فایل api/exits.js
// در فایل api/exits.js
// روت دریافت لیست (اصلاح شده برای بازگرداندن تمام فیلدها)
router.get("/", authMiddleware, async (req, res) => {
    try {
        let numericId = await getNumericMemberId(req.user.id);
        if (!numericId) numericId = 2;

        const { data, error } = await supabaseAdmin
            .from("warehouse_exits")
            .select(`
                id, exit_no, exit_date, status, total_fee,
                driver_name, plate_number, created_at,
                weighbridge_fee, extra_fee, vat_fee, extra_description, total_loading_fee, payment_method, 
                loading_order:loading_orders ( order_no ),
                customer:customers ( name ), 
                items:warehouse_exit_items (
                    id, qty, weight_net, fee_price, loading_fee, final_fee,
                    loading_item:loading_order_items (
                        batch_no,
                        product:products ( name )
                    )
                )
            `) // 👈 فیلدهای weighbridge_fee, extra_fee, batch_no, fee_price اضافه شدند
            .eq("member_id", numericId)
            .order('created_at', { ascending: false });

        if (error) throw error;
        return res.json({ success: true, data });

    } catch (e) {
        console.error("❌ Get List Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
});// ============================================================
//  2. جستجوی هوشمند (دستور بارگیری یا سند خروج)
//  GET /api/exits/search/:term
// ============================================================
router.get("/search/:term", authMiddleware, async (req, res) => {
    try {
        const term = req.params.term;
        let numericId = await getNumericMemberId(req.user.id);
        if (!numericId) numericId = 2;

        let exitRecord = null;
        let loadingOrderRecord = null;

        // A. اول: جستجو در دستورهای بارگیری
        const { data: loadingOrder } = await supabaseAdmin
            .from("loading_orders")
            .select(`*, clearance:clearances ( customer_id, customer:customers ( id, name ) )`)
            .eq("order_no", term)
            .eq("member_id", numericId)
            .maybeSingle();

        if (loadingOrder) {
            const { data: existingExit } = await supabaseAdmin
                .from("warehouse_exits")
                .select(`*, items:warehouse_exit_items (*, loading_item:loading_order_items (product:products(id, name, effective_storage_cost, effective_loading_cost, product_categories(fee_type)), clearance_items(created_at, weight), batch_no))`)
                .eq("loading_order_id", loadingOrder.id)
                .maybeSingle();

            if (existingExit) exitRecord = existingExit;
            else loadingOrderRecord = loadingOrder;
        }

        // B. دوم: جستجو در شماره سند خروج
        if (!exitRecord && !loadingOrderRecord && !isNaN(term)) {
            const { data: exitById } = await supabaseAdmin
                .from("warehouse_exits")
                .select(`*, loading_order:loading_orders ( order_no, driver_name, plate_number, clearances(customer_id, customers(name)) ), items:warehouse_exit_items (*, loading_item:loading_order_items (product:products(id, name, effective_storage_cost, effective_loading_cost, product_categories(fee_type)), clearance_items(created_at, weight), batch_no))`)
                .eq("id", term)
                .eq("member_id", numericId)
                .maybeSingle();

            if (exitById) exitRecord = exitById;
        }

        if (!exitRecord && !loadingOrderRecord) {
            return res.status(404).json({ success: false, message: "سندی یافت نشد یا دسترسی ندارید." });
        }

        let responseData = {};

        if (exitRecord) {
            responseData = {
                source: 'exit_record', is_processed: true, status: exitRecord.status, exit_id: exitRecord.id,
                loading_id: exitRecord.loading_order_id, order_no: exitRecord.loading_order?.order_no || loadingOrder?.order_no,
                driver_name: exitRecord.driver_name, plate_number: exitRecord.plate_number,
                customer_name: exitRecord.loading_order?.clearances?.customers?.name || loadingOrder?.clearance?.customer?.name,
                customer_id: exitRecord.owner_id, driver_national_code: exitRecord.driver_national_code,
                weighbridge_fee: exitRecord.weighbridge_fee, extra_fee: exitRecord.extra_fee, extra_description: exitRecord.extra_description,
                payment_method: exitRecord.payment_method, financial_account_id: exitRecord.financial_account_id,
                reference_no: exitRecord.reference_no, exit_date: exitRecord.exit_date,
                items: exitRecord.items.map(i => formatItem(i, false))
            };
        } else {
            const { data: loadItems } = await supabaseAdmin
                .from("loading_order_items")
                .select(`*, product:products(id, name, effective_storage_cost, effective_loading_cost, product_categories(fee_type)), clearance_items(created_at, weight)`)
                .eq("loading_order_id", loadingOrderRecord.id);

            responseData = {
                source: 'loading_order', is_processed: false, loading_id: loadingOrderRecord.id,
                order_no: loadingOrderRecord.order_no, driver_name: loadingOrderRecord.driver_name, plate_number: loadingOrderRecord.plate_number,
                customer_name: loadingOrderRecord.clearance?.customer?.name, customer_id: loadingOrderRecord.clearance?.customer_id,
                items: loadItems.map(i => formatItem(i, true))
            };
        }

        return res.json({ success: true, data: responseData });

    } catch (e) {
        console.error(e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

function formatItem(item, isNew) {
    const ref = isNew ? item : item.loading_item;
    const product = ref?.product;
    const clearance = ref?.clearance_items;
    const entryDate = clearance?.created_at || new Date().toISOString();

    return {
        item_id: isNew ? item.id : item.loading_item_id,
        product_name: product?.name || "نامشخص",
        batch_no: ref?.batch_no,
        qty: isNew ? (ref?.qty || 0) : (item.qty || 0),
        entry_date: entryDate,
        fee_type: product?.product_categories?.fee_type || 'weight',
        base_storage_rate: Number(product?.effective_storage_cost) || 0,
        base_loading_rate: Number(product?.effective_loading_cost) || 0,
        cleared_weight: Number(clearance?.weight) || 0,
        weight_full: isNew ? 0 : (item.weight_full || 0),
        weight_empty: isNew ? 0 : (item.weight_empty || 0),
        weight_net: isNew ? 0 : (item.weight_net || 0),
        row_storage_fee: isNew ? 0 : (item.final_fee || 0),
        row_loading_fee: isNew ? 0 : (item.loading_fee || 0)
    };
}

// ============================================================
//  3. ثبت خروج (POST)
// ============================================================
router.post("/", authMiddleware, async (req, res) => {
    try {
        let numericId = await getNumericMemberId(req.user.id);
        if (!numericId) numericId = 2;

        const payload = req.body;
        const exitNo = await generateExitNo(numericId);

        const { data: header, error: headErr } = await supabaseAdmin.from("warehouse_exits").insert({
            member_id: numericId, exit_no: exitNo, loading_order_id: payload.loading_order_id,
            owner_id: payload.owner_id, driver_name: payload.driver_name, plate_number: payload.plate_number,
            exit_date: payload.exit_date, reference_no: payload.reference_no, driver_national_code: payload.driver_national_code,
            weighbridge_fee: Number(payload.weighbridge_fee), extra_fee: Number(payload.extra_fee), extra_description: payload.extra_description,
            vat_fee: Number(payload.vat_fee), total_fee: Number(payload.total_fee), total_loading_fee: Number(payload.total_loading_fee),
            payment_method: payload.payment_method, financial_account_id: payload.financial_account_id,
            status: payload.status, description: payload.status === 'draft' ? 'ثبت موقت' : 'ثبت نهایی'
        }).select().single();

        if (headErr) throw headErr;

        const itemsData = payload.items.map(item => ({
            warehouse_exit_id: header.id, loading_item_id: item.item_id,
            weight_full: Number(item.weight_full), weight_empty: Number(item.weight_empty), weight_net: Number(item.weight_net),
            qty: Number(item.qty), fee_type: item.fee_type, fee_price: Number(item.base_storage_rate || 0),
            loading_fee: Number(item.row_loading_fee || 0), final_fee: Number(item.row_storage_fee || 0)
        }));

        const { error: itemsErr } = await supabaseAdmin.from("warehouse_exit_items").insert(itemsData);
        if (itemsErr) { await supabaseAdmin.from("warehouse_exits").delete().eq("id", header.id); throw itemsErr; }

        if (payload.status === 'final') {
            await supabaseAdmin.from("loading_orders").update({ status: 'exited' }).eq("id", payload.loading_order_id);
        }

        return res.json({ success: true, id: header.id, message: "ثبت شد" });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
//  4. دریافت جزئیات برای پرینت
//  GET /api/exits/:id
// ============================================================
router.get("/:id", authMiddleware, async (req, res) => {
    try {
        let numericId = await getNumericMemberId(req.user.id);
        if (!numericId) numericId = 2;

        const { data, error } = await supabaseAdmin
            .from("warehouse_exits")
            .select(`*, customer:customers(name), loading_order:loading_orders(order_no, driver_name, plate_number, clearance:clearances(customer:customers(name))), items:warehouse_exit_items(*, loading_item:loading_order_items(batch_no, qty, product:products(id, name), clearance_item:clearance_items(created_at, weight)))`)
            .eq("id", req.params.id)
            .eq("member_id", numericId)
            .single();

        if (error) throw error;

        const formattedItems = data.items.map(item => {
            const entryDate = item.loading_item?.clearance_item?.created_at || new Date().toISOString();
            const diffTime = Math.abs(new Date(data.exit_date) - new Date(entryDate));
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            const months = diffDays > 30 ? Math.ceil(diffDays/30) : 1;

            return {
                ...item,
                product_name: item.loading_item?.product?.name,
                batch_no: item.loading_item?.batch_no,
                entry_date: entryDate,
                months_duration: months,
                weight_net: item.weight_net,
                cleared_weight: item.loading_item?.clearance_item?.weight,
                row_storage_fee: item.final_fee
            };
        });

        const result = {
            ...data,
            customer_name: data.customer?.name || data.loading_order?.clearance?.customer?.name,
            driver_name: data.driver_name, plate_number: data.plate_number, order_no: data.loading_order?.order_no,
            items: formattedItems
        };

        return res.json({ success: true, data: result });
    } catch(e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
//  5. حذف سند خروج - ✅ اضافه شد
//  DELETE /api/exits/:id
// ============================================================
router.delete("/:id", authMiddleware, async (req, res) => {
    try {
        let numericId = await getNumericMemberId(req.user.id);
        if (!numericId) numericId = 2;

        const exitId = req.params.id;

        const { data: exitRecord, error: findErr } = await supabaseAdmin
            .from("warehouse_exits").select("id, loading_order_id, member_id").eq("id", exitId).single();

        if (findErr || !exitRecord) return res.status(404).json({ success: false, error: "سند یافت نشد" });
        if (exitRecord.member_id !== numericId) return res.status(403).json({ success: false, error: "دسترسی غیرمجاز" });

        // حذف آیتم‌ها
        await supabaseAdmin.from("warehouse_exit_items").delete().eq("warehouse_exit_id", exitId);

        // حذف هدر
        const { error: delErr } = await supabaseAdmin.from("warehouse_exits").delete().eq("id", exitId);
        if (delErr) throw delErr;

        // آزاد کردن دستور بارگیری (بازگشت به وضعیت issued)
        await supabaseAdmin.from("loading_orders").update({ status: 'issued' }).eq("id", exitRecord.loading_order_id);

        return res.json({ success: true, message: "سند حذف شد." });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;