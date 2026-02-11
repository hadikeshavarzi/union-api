// api/clearances.js
const express = require("express");
const { supabaseAdmin } = require("../supabaseAdmin");
const authMiddleware = require("./middleware/auth");

const router = express.Router();

/* ============================================================
   Helpers
============================================================ */
function toNumber(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function uniq(arr) {
    return [...new Set((arr || []).filter((x) => x !== null && x !== undefined))];
}

// ساخت OR برای eq:  col.eq.1,col.eq.2,...
function orEqList(col, ids) {
    const clean = uniq(ids).map((x) => toNumber(x)).filter((x) => Number.isFinite(x));
    if (!clean.length) return null;
    return clean.map((id) => `${col}.eq.${id}`).join(",");
}

/* ============================================================
   Helper: تبدیل UUID به عدد (حل مشکل 22P02)
============================================================ */
async function getNumericMemberId(idInput) {
    if (!idInput) return null;

    // اگر از قبل عددی است
    if (!isNaN(idInput) && !String(idInput).includes("-")) return Number(idInput);

    // اگر UUID است: از members با auth_user_id پیدا کن
    const { data, error } = await supabaseAdmin
        .from("members")
        .select("id")
        .eq("auth_user_id", idInput)
        .maybeSingle();

    if (error) {
        console.error("❌ Database Error in getNumericMemberId:", error.message);
        return null;
    }
    return data ? Number(data.id) : null;
}

/* ============================================================
   Helper: تولید شماره ترخیص اختصاصی
============================================================ */
async function generateClearanceNo(memberId) {
    const { count, error } = await supabaseAdmin
        .from("clearances")
        .select("*", { count: "exact", head: true })
        .eq("member_id", memberId);

    if (error) throw new Error(error.message);

    // فرمول: (آیدی انبار * 1000) + سری 200 + (تعداد + 1)
    return memberId * 1000 + 200 + (toNumber(count) + 1);
}

/* ============================================================
   1) Owner Products Summary
   - بدون join
   - بدون in
============================================================ */
router.get("/owner-products/:ownerId", authMiddleware, async (req, res) => {
    try {
        const owner_id = toNumber(req.params.ownerId);
        let member_id = await getNumericMemberId(req.user.id);
        if (!member_id) member_id = 2; // fallback

        // 1) receipts متعلق به owner/member
        const { data: receipts, error: recErr } = await supabaseAdmin
            .from("receipts")
            .select("id")
            .eq("owner_id", owner_id)
            .eq("member_id", member_id);

        if (recErr) throw new Error(recErr.message);

        const receiptIds = uniq((receipts || []).map((r) => r.id));
        if (!receiptIds.length) {
            return res.json({ success: true, data: [] });
        }

        // 2) receipt_items برای آن receipts (با OR)
        const orReceipt = orEqList("receipt_id", receiptIds);
        let itemsQuery = supabaseAdmin
            .from("receipt_items")
            .select("receipt_id, product_id, count, weights_net, row_code");

        if (orReceipt) itemsQuery = itemsQuery.or(orReceipt);

        const { data: receiptItems, error: itErr } = await itemsQuery;
        if (itErr) throw new Error(itErr.message);

        // 3) inventory_transactions برای owner/member
        const { data: txs, error: txErr } = await supabaseAdmin
            .from("inventory_transactions")
            .select("product_id, qty, weight")
            .eq("owner_id", owner_id)
            .eq("member_id", member_id);

        if (txErr) throw new Error(txErr.message);

        // 4) fetch product names (با OR روی products.id)
        const productIds = uniq((receiptItems || []).map((x) => x.product_id));
        let productNames = {};

        if (productIds.length) {
            const orProd = orEqList("id", productIds);
            let pQuery = supabaseAdmin.from("products").select("id, name");
            if (orProd) pQuery = pQuery.or(orProd);

            const { data: prods, error: pErr } = await pQuery;
            if (pErr) throw new Error(pErr.message);

            (prods || []).forEach((p) => (productNames[p.id] = p.name));
        }

        // 5) aggregation
        const map = {};

        // ورودی از receipt_items
        (receiptItems || []).forEach((it) => {
            const pid = it.product_id;
            if (!map[pid]) {
                map[pid] = {
                    product_id: pid,
                    product_title: productNames[pid] || "کالای نامشخص",
                    total_qty_available: 0,
                    total_weight_available: 0,
                };
            }
            map[pid].total_qty_available += toNumber(it.count);
            map[pid].total_weight_available += toNumber(it.weights_net);
        });

        // جمع جبری با تراکنش‌ها
        (txs || []).forEach((tx) => {
            const pid = tx.product_id;
            if (!map[pid]) return; // فقط چیزهایی که از receipt فهمیدیم (مثل نسخه خودت)
            map[pid].total_qty_available += toNumber(tx.qty);
            map[pid].total_weight_available += toNumber(tx.weight);
        });

        const summary = Object.values(map).filter((x) => x.total_qty_available > 0);

        return res.json({ success: true, data: summary });
    } catch (e) {
        console.error("❌ Owner Products Error:", e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   2) Batches
   - بدون join
   - بدون in
============================================================ */
router.get("/batches", authMiddleware, async (req, res) => {
    try {
        const owner_id = toNumber(req.query.owner_id);
        const product_id = toNumber(req.query.product_id);

        let member_id = await getNumericMemberId(req.user.id);
        if (!member_id) member_id = 2;

        if (!owner_id || !product_id) {
            return res.status(400).json({ success: false, error: "Missing params: owner_id, product_id" });
        }

        // 1) receipts ids
        const { data: receipts, error: recErr } = await supabaseAdmin
            .from("receipts")
            .select("id")
            .eq("owner_id", owner_id)
            .eq("member_id", member_id);

        if (recErr) throw new Error(recErr.message);

        const receiptIds = uniq((receipts || []).map((r) => r.id));
        if (!receiptIds.length) return res.json({ success: true, data: [] });

        // 2) receipt_items for those receipts + product_id
        const orReceipt = orEqList("receipt_id", receiptIds);
        let riQuery = supabaseAdmin
            .from("receipt_items")
            .select("id, receipt_id, product_id, row_code, count, weights_net")
            .eq("product_id", product_id);

        if (orReceipt) riQuery = riQuery.or(orReceipt);

        const { data: receiptItems, error: riErr } = await riQuery;
        if (riErr) throw new Error(riErr.message);

        // 3) all inventory tx for that owner/product/member
        const { data: allTx, error: txErr } = await supabaseAdmin
            .from("inventory_transactions")
            .select("id, product_id, qty, weight, batch_no, parent_batch_no, ref_type, ref_id, created_at")
            .eq("owner_id", owner_id)
            .eq("member_id", member_id)
            .eq("product_id", product_id);

        if (txErr) throw new Error(txErr.message);

        const result = [];

        (receiptItems || []).forEach((receipt) => {
            const batchName = receipt.row_code || `ID-${receipt.id}`;

            let currentQty = toNumber(receipt.count);
            let currentWeight = toNumber(receipt.weights_net);

            const relatedTx = (allTx || []).filter((tx) => {
                if (!tx.batch_no) return false;
                return tx.batch_no === batchName || String(tx.batch_no).startsWith(batchName + "/");
            });

            relatedTx.forEach((tx) => {
                currentQty += toNumber(tx.qty);
                currentWeight += toNumber(tx.weight);
            });

            if (currentQty > 0) {
                const history = relatedTx.map((tx) => ({
                    ...tx,
                    display_qty: Math.abs(toNumber(tx.qty)),
                    display_weight: Math.abs(toNumber(tx.weight)),
                    qty: toNumber(tx.qty),
                    weight: toNumber(tx.weight),
                    parent_batch_no: batchName,
                }));

                result.push({
                    batch_no: batchName,
                    qty_available: currentQty,
                    weight_available: currentWeight,
                    history,
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
   3) CREATE Clearance
   - بدون rpc
   - به جای rpc: ثبت inventory_transactions (کسر موجودی)
============================================================ */
router.post("/", authMiddleware, async (req, res) => {
    try {
        let member_id = await getNumericMemberId(req.user.id);
        if (!member_id) member_id = 2;

        const {
            customer_id,
            clearance_date,
            receiver_person_name,
            receiver_person_national_id,
            driver_name,
            plate,
            description,
            items,
            doc_type_id = 1,
        } = req.body;

        if (!customer_id) {
            return res.status(400).json({ success: false, error: "customer_id الزامی است" });
        }
        if (!Array.isArray(items) || !items.length) {
            return res.status(400).json({ success: false, error: "items الزامی است" });
        }

        const clearanceNo = await generateClearanceNo(member_id);

        // A) Header
        const { data: clearance, error: hErr } = await supabaseAdmin
            .from("clearances")
            .insert({
                doc_type_id,
                clearance_no: clearanceNo,
                member_id,
                status: "final",
                clearance_date: clearance_date || new Date().toISOString(),
                customer_id,
                receiver_person_name: receiver_person_name || null,
                receiver_person_national_id: receiver_person_national_id || null,
                driver_name: driver_name || null,
                vehicle_plate_iran_right: plate?.right2 || null,
                vehicle_plate_mid3: plate?.middle3 || null,
                vehicle_plate_letter: plate?.letter || null,
                vehicle_plate_left2: plate?.left2 || null,
                description: description || null,
            })
            .select()
            .single();

        if (hErr) {
            console.error("❌ Clearance Header Error:", hErr.message);
            return res.status(500).json({ success: false, error: hErr.message });
        }

        // B) Items
        const formattedItems = items.map((item) => ({
            clearance_id: clearance.id,
            product_id: toNumber(item.product_id),
            owner_id: toNumber(customer_id),
            qty: toNumber(item.qty),
            weight: toNumber(item.weight),
            parent_batch_no: item.parent_batch_no || null,
            batch_no: item.batch_no || null,
            status: "issued",
        }));

        const { error: iErr } = await supabaseAdmin.from("clearance_items").insert(formattedItems);
        if (iErr) {
            await supabaseAdmin.from("clearances").delete().eq("id", clearance.id);
            console.error("❌ Clearance Items Error:", iErr.message);
            return res.status(500).json({ success: false, error: iErr.message });
        }

        // C) Inventory Sync (جایگزین rpc)
        // هر آیتم ترخیص => یک تراکنش منفی در inventory_transactions
        const nowIso = new Date().toISOString();
        const txRows = formattedItems.map((it) => ({
            member_id,
            owner_id: toNumber(customer_id),
            product_id: toNumber(it.product_id),
            qty: -Math.abs(toNumber(it.qty)),
            weight: -Math.abs(toNumber(it.weight)),
            batch_no: it.batch_no || it.parent_batch_no || null,
            parent_batch_no: it.parent_batch_no || null,
            ref_type: "clearance",
            ref_id: clearance.id,
            created_at: nowIso,
        }));

        const { error: txErr } = await supabaseAdmin.from("inventory_transactions").insert(txRows);
        if (txErr) {
            // اگر اینجا خطا خورد، ما rollback کامل نمی‌کنیم چون ترخیص ثبت شده
            // ولی حداقل گزارش دقیق می‌دهیم
            console.error("❌ Inventory Sync Error:", txErr.message);
            return res.status(500).json({
                success: false,
                error: "ترخیص ثبت شد اما کسر موجودی ناموفق بود",
                details: txErr.message,
                id: clearance.id,
                clearance_no: clearanceNo,
            });
        }

        return res.json({
            success: true,
            clearance_no: clearanceNo,
            id: clearance.id,
            message: "سند ترخیص با موفقیت ثبت و موجودی کسر شد.",
        });
    } catch (e) {
        console.error("❌ Server Error:", e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   4) REPORT
   - بدون join/embed
============================================================ */
router.get("/report", authMiddleware, async (req, res) => {
    try {
        let member_id = await getNumericMemberId(req.user.id);
        if (!member_id) member_id = 2;

        // 1) clearances
        const { data: clearances, error: cErr } = await supabaseAdmin
            .from("clearances")
            .select("*")
            .eq("member_id", member_id)
            .order("clearance_date", { ascending: false });

        if (cErr) throw new Error(cErr.message);

        const clearanceIds = uniq((clearances || []).map((c) => c.id));
        const customerIds = uniq((clearances || []).map((c) => c.customer_id));

        // 2) customers map
        let customersMap = {};
        if (customerIds.length) {
            const orCust = orEqList("id", customerIds);
            let custQ = supabaseAdmin.from("customers").select("id, name");
            if (orCust) custQ = custQ.or(orCust);

            const { data: customers, error: cuErr } = await custQ;
            if (cuErr) throw new Error(cuErr.message);

            (customers || []).forEach((c) => (customersMap[c.id] = c));
        }

        // 3) clearance_items
        let items = [];
        if (clearanceIds.length) {
            const orClr = orEqList("clearance_id", clearanceIds);
            let itQ = supabaseAdmin.from("clearance_items").select("*");
            if (orClr) itQ = itQ.or(orClr);

            const { data: its, error: iErr } = await itQ;
            if (iErr) throw new Error(iErr.message);

            items = its || [];
        }

        // 4) products map
        const productIds = uniq(items.map((i) => i.product_id));
        let productsMap = {};
        if (productIds.length) {
            const orProd = orEqList("id", productIds);
            let pQ = supabaseAdmin.from("products").select("id, name");
            if (orProd) pQ = pQ.or(orProd);

            const { data: prods, error: pErr } = await pQ;
            if (pErr) throw new Error(pErr.message);

            (prods || []).forEach((p) => (productsMap[p.id] = p));
        }

        // 5) assemble
        const itemsByClearance = {};
        items.forEach((it) => {
            const cid = it.clearance_id;
            if (!itemsByClearance[cid]) itemsByClearance[cid] = [];
            itemsByClearance[cid].push({
                ...it,
                product: productsMap[it.product_id] || null,
            });
        });

        const out = (clearances || []).map((c) => ({
            ...c,
            customer: customersMap[c.customer_id] || null,
            clearance_items: itemsByClearance[c.id] || [],
        }));

        return res.json({ success: true, data: out });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
