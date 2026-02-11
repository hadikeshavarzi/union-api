// api/inventoryTransactions.js - MULTI-TENANT (Adapter-safe: no rpc, no embed, no range/gte/lte)
const express = require("express");
const { supabaseAdmin } = require("../supabaseAdmin");
const authMiddleware = require("./middleware/auth");

const router = express.Router();

/* ============================================================
   Helpers
============================================================ */

async function getNumericMemberId(idInput) {
    if (!idInput) return null;
    if (!isNaN(idInput) && !String(idInput).includes("-")) return Number(idInput);

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

function isValidDateStr(s) {
    if (!s) return false;
    const d = new Date(s);
    return !isNaN(d.getTime());
}

// محاسبه موجودی فعلی از روی تراکنش‌ها (جایگزین rpc get_stock)
async function getCurrentStockQty(product_id, owner_id, member_id) {
    const { data, error } = await supabaseAdmin
        .from("inventory_transactions")
        .select("qty")
        .eq("member_id", member_id)
        .eq("product_id", Number(product_id))
        .eq("owner_id", Number(owner_id));

    if (error) throw new Error(error.message);

    let sum = 0;
    (data || []).forEach((r) => (sum += toNum(r.qty)));
    return sum;
}

// اگر وزن هم خواستی
async function getCurrentStockWeight(product_id, owner_id, member_id) {
    const { data, error } = await supabaseAdmin
        .from("inventory_transactions")
        .select("weight")
        .eq("member_id", member_id)
        .eq("product_id", Number(product_id))
        .eq("owner_id", Number(owner_id));

    if (error) throw new Error(error.message);

    let sum = 0;
    (data || []).forEach((r) => (sum += toNum(r.weight)));
    return sum;
}

async function getProductsMap(memberId, ids) {
    const { data, error } = await supabaseAdmin
        .from("products")
        .select("id,name,sku,unit_id,member_id")
        .eq("member_id", memberId);

    if (error) throw new Error(error.message);

    const set = new Set((ids || []).map(String));
    const map = {};
    (data || []).forEach((p) => {
        if (set.has(String(p.id))) map[p.id] = p;
    });
    return map;
}

async function getOwnersMap(memberId, ids) {
    const { data, error } = await supabaseAdmin
        .from("customers")
        .select("id,name,member_id")
        .eq("member_id", memberId);

    if (error) throw new Error(error.message);

    const set = new Set((ids || []).map(String));
    const map = {};
    (data || []).forEach((c) => {
        if (set.has(String(c.id))) map[c.id] = c;
    });
    return map;
}

async function getUnitsMap(ids) {
    if (!ids || ids.length === 0) return {};

    const { data, error } = await supabaseAdmin
        .from("product_units")
        .select("id,name,symbol");

    if (error) throw new Error(error.message);

    const set = new Set(ids.map(String));
    const map = {};
    (data || []).forEach((u) => {
        if (set.has(String(u.id))) map[u.id] = u;
    });
    return map;
}

/* ============================================================
   GET ALL TRANSACTIONS
   GET /api/inventory-transactions
   نکته: چون adapter range/gte/lte ندارد، فیلترها را در Node اعمال می‌کنیم
============================================================ */
router.get("/", authMiddleware, async (req, res) => {
    try {
        const {
            limit = 100,
            offset = 0,
            product_id,
            owner_id,
            type,
            transaction_type,
            date_from,
            date_to,
        } = req.query;

        let member_id = await getNumericMemberId(req.user.id);
        if (!member_id) member_id = 2;

        // 1) خواندن تراکنش‌ها (بدون embed)
        let query = supabaseAdmin
            .from("inventory_transactions")
            .select("*", { count: "exact" })
            .eq("member_id", member_id)
            .order("created_at", { ascending: false });

        if (product_id) query = query.eq("product_id", Number(product_id));
        if (owner_id) query = query.eq("owner_id", Number(owner_id));
        if (type) query = query.eq("type", type);
        if (transaction_type) query = query.eq("transaction_type", transaction_type);

        const { data: rows, error, count } = await query;
        if (error) return res.status(400).json({ success: false, error: error.message });

        let data = rows || [];

        // 2) فیلتر تاریخ در Node (چون gte/lte نداریم)
        const hasFrom = isValidDateStr(date_from);
        const hasTo = isValidDateStr(date_to);
        if (hasFrom || hasTo) {
            const from = hasFrom ? new Date(date_from) : null;
            const to = hasTo ? new Date(date_to) : null;

            data = data.filter((r) => {
                const d = new Date(r.transaction_date || r.created_at);
                if (isNaN(d.getTime())) return false;
                if (from && d < from) return false;
                if (to && d > to) return false;
                return true;
            });
        }

        // 3) pagination در Node
        const lim = Math.max(1, Number(limit));
        const off = Math.max(0, Number(offset));
        const total = data.length; // دقیق بعد از فیلتر تاریخ
        data = data.slice(off, off + lim);

        // 4) join دستی برای product/owner/unit
        const productIds = [...new Set(data.map((r) => r.product_id).filter(Boolean))];
        const ownerIds = [...new Set(data.map((r) => r.owner_id).filter(Boolean))];

        const productsMap = await getProductsMap(member_id, productIds);
        const unitIds = [...new Set(Object.values(productsMap).map((p) => p.unit_id).filter(Boolean))];
        const unitsMap = await getUnitsMap(unitIds);
        const ownersMap = await getOwnersMap(member_id, ownerIds);

        const enriched = data.map((t) => {
            const p = productsMap[t.product_id] || null;
            const u = p?.unit_id ? (unitsMap[p.unit_id] || null) : null;
            const o = ownersMap[t.owner_id] || null;

            return {
                ...t,
                product: p
                    ? { id: p.id, name: p.name, sku: p.sku, unit: u ? { name: u.name, symbol: u.symbol } : null }
                    : null,
                owner: o ? { id: o.id, name: o.name } : null,
            };
        });

        return res.json({
            success: true,
            data: enriched,
            total, // بعد از فیلترها
            limit: lim,
            offset: off,
            // اگر خواستی count خام DB هم داشته باشی:
            total_db: typeof count === "number" ? count : undefined,
        });
    } catch (e) {
        console.error("❌ Server Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   GET ONE TRANSACTION
============================================================ */
router.get("/:id", authMiddleware, async (req, res) => {
    try {
        const transaction_id = Number(req.params.id);

        let member_id = await getNumericMemberId(req.user.id);
        if (!member_id) member_id = 2;

        const { data, error } = await supabaseAdmin
            .from("inventory_transactions")
            .select("*")
            .eq("id", transaction_id)
            .eq("member_id", member_id)
            .single();

        if (error || !data) {
            return res.status(404).json({
                success: false,
                error: "تراکنش یافت نشد یا دسترسی ندارید",
            });
        }

        // join دستی برای این رکورد
        const productsMap = await getProductsMap(member_id, [data.product_id].filter(Boolean));
        const p = productsMap[data.product_id] || null;
        const unitsMap = await getUnitsMap(p?.unit_id ? [p.unit_id] : []);
        const u = p?.unit_id ? (unitsMap[p.unit_id] || null) : null;

        const ownersMap = await getOwnersMap(member_id, [data.owner_id].filter(Boolean));
        const o = ownersMap[data.owner_id] || null;

        return res.json({
            success: true,
            data: {
                ...data,
                product: p ? { id: p.id, name: p.name, sku: p.sku, unit: u ? { name: u.name, symbol: u.symbol } : null } : null,
                owner: o ? { id: o.id, name: o.name } : null,
            },
        });
    } catch (e) {
        console.error("❌ Server Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   CREATE TRANSACTION (manual)
============================================================ */
router.post("/", authMiddleware, async (req, res) => {
    try {
        let member_id = await getNumericMemberId(req.user.id);
        if (!member_id) member_id = 2;

        const { product_id, owner_id, qty, weight, type, transaction_type, description, batch_no } = req.body;

        if (!product_id || !owner_id || qty === undefined || qty === null) {
            return res.status(400).json({
                success: false,
                error: "product_id، owner_id و qty الزامی است",
            });
        }

        // مالکیت محصول و مشتری
        const { data: product } = await supabaseAdmin
            .from("products")
            .select("id")
            .eq("id", Number(product_id))
            .eq("member_id", member_id)
            .maybeSingle();

        const { data: owner } = await supabaseAdmin
            .from("customers")
            .select("id")
            .eq("id", Number(owner_id))
            .eq("member_id", member_id)
            .maybeSingle();

        if (!product || !owner) {
            return res.status(403).json({
                success: false,
                error: "محصول یا مالک یافت نشد یا دسترسی ندارید",
            });
        }

        const qtyNum = toNum(qty);
        const weightNum = weight === undefined || weight === null ? null : toNum(weight);

        // موجودی قبل/بعد (بدون rpc)
        const stockBeforeQty = await getCurrentStockQty(product_id, owner_id, member_id);
        const stockBeforeWeight = weightNum === null ? null : await getCurrentStockWeight(product_id, owner_id, member_id);

        // نکته مهم:
        // پیشنهاد استاندارد: qty/weight را با علامت واقعی ذخیره کنیم.
        // اگر type = exit -> منفی ذخیره کن تا جمع جبری درست بماند.
        const sign = (type && String(type).toLowerCase() === "exit") ? -1 : 1;

        const qtySigned = qtyNum * sign;
        const weightSigned = weightNum === null ? null : (weightNum * sign);

        const stockAfterQty = stockBeforeQty + qtySigned;

        const payload = {
            type: type || "entry",
            transaction_type: transaction_type || "manual",
            product_id: Number(product_id),
            owner_id: Number(owner_id),

            qty: qtySigned,                 // ✅ با علامت
            weight: weightSigned,           // ✅ با علامت

            qty_real: qtyNum,               // نمایش/گزارش
            weight_real: weightNum,

            snapshot_qty_before: stockBeforeQty,
            snapshot_qty_after: stockAfterQty,

            batch_no: batch_no || null,
            description: description || null,

            member_id,
            transaction_date: new Date().toISOString(),
        };

        const { data, error } = await supabaseAdmin
            .from("inventory_transactions")
            .insert(payload)
            .select()
            .single();

        if (error) {
            console.error("❌ Create Transaction Error:", error);
            return res.status(400).json({ success: false, error: error.message });
        }

        return res.json({ success: true, data });
    } catch (e) {
        console.error("❌ Server Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   DELETE TRANSACTION (manual only)
============================================================ */
router.delete("/:id", authMiddleware, async (req, res) => {
    try {
        const transaction_id = Number(req.params.id);

        let member_id = await getNumericMemberId(req.user.id);
        if (!member_id) member_id = 2;

        const { data: existing } = await supabaseAdmin
            .from("inventory_transactions")
            .select("id, transaction_type")
            .eq("id", transaction_id)
            .eq("member_id", member_id)
            .maybeSingle();

        if (!existing) {
            return res.status(404).json({
                success: false,
                error: "تراکنش یافت نشد یا دسترسی ندارید",
            });
        }

        if (existing.transaction_type !== "manual") {
            return res.status(400).json({
                success: false,
                error: "فقط تراکنش‌های دستی قابل حذف هستند",
            });
        }

        const { error } = await supabaseAdmin
            .from("inventory_transactions")
            .delete()
            .eq("id", transaction_id)
            .eq("member_id", member_id);

        if (error) {
            console.error("❌ Delete Transaction Error:", error);
            return res.status(400).json({ success: false, error: error.message });
        }

        return res.json({ success: true });
    } catch (e) {
        console.error("❌ Server Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
