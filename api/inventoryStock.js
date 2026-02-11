// api/inventoryStock.js - MULTI-TENANT (Adapter-safe: no embed, no rpc)
const express = require("express");
const { supabaseAdmin } = require("../supabaseAdmin");
const authMiddleware = require("./middleware/auth");

const router = express.Router();

/* ============================================================
   Helpers
============================================================ */

async function getNumericMemberId(idInput) {
    if (!idInput) return null;
    // اگر عددی است
    if (!isNaN(idInput) && !String(idInput).includes("-")) return Number(idInput);

    // اگر UUID است -> از members پیدا کن
    const { data, error } = await supabaseAdmin
        .from("members")
        .select("id")
        .eq("auth_user_id", idInput)
        .maybeSingle();

    if (error) return null;
    return data ? Number(data.id) : null;
}

function toNum(v, d = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
}

function pushAgg(map, key, tx) {
    if (!map[key]) {
        map[key] = {
            product_id: tx.product_id,
            owner_id: tx.owner_id,
            qty_in: 0,
            weight_in: 0,
            qty_out: 0,
            weight_out: 0,
            qty_on_hand: 0,
            weight_on_hand: 0,
            product: null,
            owner: null,
        };
    }

    const qty = toNum(tx.qty);
    const weight = toNum(tx.weight);

    // جمع جبری موجودی
    map[key].qty_on_hand += qty;
    map[key].weight_on_hand += weight;

    // تفکیک ورودی/خروجی برای گزارش
    if (qty >= 0) map[key].qty_in += qty;
    else map[key].qty_out += Math.abs(qty);

    if (weight >= 0) map[key].weight_in += weight;
    else map[key].weight_out += Math.abs(weight);
}

async function getProductsMap(memberId, productIds) {
    // Adapter شما .in ندارد، پس کل محصولات member را می‌گیریم و فیلتر می‌کنیم
    const { data, error } = await supabaseAdmin
        .from("products")
        .select("id,name,sku,unit_id,member_id")
        .eq("member_id", memberId);

    if (error) throw new Error(error.message);

    const set = new Set((productIds || []).map(String));
    const map = {};
    (data || []).forEach((p) => {
        if (set.has(String(p.id))) map[p.id] = p;
    });

    return map;
}

async function getUnitsMap(unitIds) {
    if (!unitIds || unitIds.length === 0) return {};

    const { data, error } = await supabaseAdmin
        .from("product_units")
        .select("id,name,symbol");

    if (error) throw new Error(error.message);

    const set = new Set(unitIds.map(String));
    const map = {};
    (data || []).forEach((u) => {
        if (set.has(String(u.id))) map[u.id] = u;
    });

    return map;
}

async function getOwnersMap(memberId, ownerIds) {
    // مشتریان خود ممبر
    const { data, error } = await supabaseAdmin
        .from("customers")
        .select("id,name,member_id")
        .eq("member_id", memberId);

    if (error) throw new Error(error.message);

    const set = new Set((ownerIds || []).map(String));
    const map = {};
    (data || []).forEach((c) => {
        if (set.has(String(c.id))) map[c.id] = c;
    });

    return map;
}

/* ============================================================
   GET /api/inventory-stock
   موجودی انبار (محاسبه از inventory_transactions)
============================================================ */
router.get("/", authMiddleware, async (req, res) => {
    try {
        const { product_id, owner_id } = req.query;

        let memberId = await getNumericMemberId(req.user.id);
        if (!memberId) memberId = 2; // fallback مثل بقیه route ها

        // 1) تراکنش‌ها (فقط tenant خودش)
        let txQuery = supabaseAdmin
            .from("inventory_transactions")
            .select("id,member_id,product_id,owner_id,qty,weight,created_at")
            .eq("member_id", memberId);

        if (product_id) txQuery = txQuery.eq("product_id", Number(product_id));
        if (owner_id) txQuery = txQuery.eq("owner_id", Number(owner_id));

        const { data: txs, error: txErr } = await txQuery;
        if (txErr) throw new Error(txErr.message);

        const list = txs || [];
        if (list.length === 0) return res.json({ success: true, data: [] });

        // 2) aggregate
        const agg = {};
        for (const tx of list) {
            if (!tx.product_id || !tx.owner_id) continue;
            const key = `${tx.product_id}:${tx.owner_id}`;
            pushAgg(agg, key, tx);
        }

        const rows = Object.values(agg);

        // 3) fetch product/owner info and merge
        const productIds = [...new Set(rows.map(r => r.product_id).filter(Boolean))];
        const ownerIds = [...new Set(rows.map(r => r.owner_id).filter(Boolean))];

        const productsMap = await getProductsMap(memberId, productIds);
        const unitIds = [...new Set(Object.values(productsMap).map(p => p.unit_id).filter(Boolean))];
        const unitsMap = await getUnitsMap(unitIds);
        const ownersMap = await getOwnersMap(memberId, ownerIds);

        const cleanData = rows.map(r => {
            const p = productsMap[r.product_id] || null;
            const u = p?.unit_id ? (unitsMap[p.unit_id] || null) : null;
            const o = ownersMap[r.owner_id] || null;

            return {
                product_id: r.product_id,
                owner_id: r.owner_id,

                qty_in: r.qty_in,
                weight_in: r.weight_in,
                qty_out: r.qty_out,
                weight_out: r.weight_out,
                qty_on_hand: r.qty_on_hand,
                weight_on_hand: r.weight_on_hand,

                product: p ? {
                    id: p.id,
                    name: p.name,
                    sku: p.sku,
                    member_id: p.member_id,
                    unit: u ? { name: u.name, symbol: u.symbol } : null,
                } : null,

                owner: o ? {
                    id: o.id,
                    name: o.name,
                    member_id: o.member_id,
                } : null,
            };
        });

        return res.json({ success: true, data: cleanData });
    } catch (e) {
        console.error("❌ Inventory Stock Error:", e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   GET /api/inventory-stock/by-product-owner
   موجودی دقیق یک محصول برای یک owner (بدون rpc)
============================================================ */
router.get("/by-product-owner", authMiddleware, async (req, res) => {
    try {
        const { product_id, owner_id } = req.query;

        if (!product_id || !owner_id) {
            return res.status(400).json({
                success: false,
                error: "product_id و owner_id الزامی است",
            });
        }

        let memberId = await getNumericMemberId(req.user.id);
        if (!memberId) memberId = 2;

        const pid = Number(product_id);
        const oid = Number(owner_id);

        // فقط تراکنش‌های همین tenant و همین کالا/مالک
        const { data: txs, error } = await supabaseAdmin
            .from("inventory_transactions")
            .select("qty,weight")
            .eq("member_id", memberId)
            .eq("product_id", pid)
            .eq("owner_id", oid);

        if (error) throw new Error(error.message);

        let qtyOnHand = 0;
        let weightOnHand = 0;

        (txs || []).forEach(tx => {
            qtyOnHand += toNum(tx.qty);
            weightOnHand += toNum(tx.weight);
        });

        return res.json({
            success: true,
            data: {
                product_id: pid,
                owner_id: oid,
                qty_on_hand: qtyOnHand,
                weight_on_hand: weightOnHand,
            },
        });
    } catch (e) {
        console.error("❌ by-product-owner Error:", e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
