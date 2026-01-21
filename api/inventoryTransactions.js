// api/inventoryTransactions.js - MULTI-TENANT
const express = require("express");
const { supabaseAdmin } = require("../supabaseAdmin");
const authMiddleware = require("./middleware/auth");

const router = express.Router();

/* ============================================================
   Helper: محاسبه موجودی فعلی
============================================================ */
async function getCurrentStock(product_id, owner_id, member_id) {
    const { data, error } = await supabaseAdmin.rpc("get_stock", {
        p_product_id: product_id,
        p_owner_id: owner_id,
        p_member_id: member_id
    });

    if (error) {
        console.error("❌ RPC Error:", error);
        return 0;
    }

    return data || 0;
}

/* ============================================================
   GET ALL TRANSACTIONS (لیست تراکنش‌ها)
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
            date_to
        } = req.query;
        const member_id = req.user.id;

        let query = supabaseAdmin
            .from("inventory_transactions")
            .select(`
                *,
                product:products (id, name, sku, unit:product_units(name)),
                owner:customers (id, name)
            `, { count: "exact" })
            .eq("member_id", member_id) // ✅ فیلتر تنانت
            .order("created_at", { ascending: false });

        // فیلترها
        if (product_id) query = query.eq("product_id", product_id);
        if (owner_id) query = query.eq("owner_id", owner_id);
        if (type) query = query.eq("type", type);
        if (transaction_type) query = query.eq("transaction_type", transaction_type);
        if (date_from) query = query.gte("transaction_date", date_from);
        if (date_to) query = query.lte("transaction_date", date_to);

        // صفحه‌بندی
        query = query.range(Number(offset), Number(offset) + Number(limit) - 1);

        const { data, error, count } = await query;

        if (error) {
            console.error("❌ GET Transactions Error:", error);
            return res.status(400).json({ success: false, error: error.message });
        }

        return res.json({ success: true, data, total: count });
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
        const member_id = req.user.id;

        const { data, error } = await supabaseAdmin
            .from("inventory_transactions")
            .select(`
                *,
                product:products (id, name, sku, unit:product_units(name)),
                owner:customers (id, name)
            `)
            .eq("id", transaction_id)
            .eq("member_id", member_id) // ✅ فیلتر تنانت
            .single();

        if (error || !data) {
            return res.status(404).json({
                success: false,
                error: "تراکنش یافت نشد یا دسترسی ندارید"
            });
        }

        return res.json({ success: true, data });
    } catch (e) {
        console.error("❌ Server Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   CREATE TRANSACTION (ثبت دستی تراکنش)
   ⚠️ معمولاً از طریق receipts/clearances ثبت می‌شود
============================================================ */
router.post("/", authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.id;
        const { product_id, owner_id, qty, weight, type, transaction_type, description, batch_no } = req.body;

        // اعتبارسنجی
        if (!product_id || !owner_id || !qty) {
            return res.status(400).json({
                success: false,
                error: "product_id، owner_id و qty الزامی است"
            });
        }

        // ✅ چک اینکه product و owner متعلق به این member باشند
        const { data: product } = await supabaseAdmin
            .from("products")
            .select("id")
            .eq("id", product_id)
            .eq("member_id", member_id)
            .single();

        const { data: owner } = await supabaseAdmin
            .from("customers")
            .select("id")
            .eq("id", owner_id)
            .eq("member_id", member_id)
            .single();

        if (!product || !owner) {
            return res.status(403).json({
                success: false,
                error: "محصول یا مالک یافت نشد یا دسترسی ندارید"
            });
        }

        // محاسبه موجودی قبل و بعد
        const stockBefore = await getCurrentStock(product_id, owner_id, member_id);
        const stockAfter = type === "entry"
            ? stockBefore + Number(qty)
            : stockBefore - Number(qty);

        const payload = {
            type: type || "entry",
            transaction_type: transaction_type || "manual",
            product_id,
            owner_id,
            qty: Number(qty),
            weight: weight ? Number(weight) : null,
            qty_real: Number(qty),
            weight_real: weight ? Number(weight) : null,
            snapshot_qty_before: stockBefore,
            snapshot_qty_after: stockAfter,
            batch_no,
            description,
            member_id, // ✅ تزریق خودکار
            transaction_date: new Date().toISOString()
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
   DELETE TRANSACTION (حذف تراکنش دستی)
   ⚠️ تراکنش‌های مرتبط با اسناد نباید حذف شوند
============================================================ */
router.delete("/:id", authMiddleware, async (req, res) => {
    try {
        const transaction_id = Number(req.params.id);
        const member_id = req.user.id;

        // چک اینکه تراکنش manual باشه
        const { data: existing } = await supabaseAdmin
            .from("inventory_transactions")
            .select("id, transaction_type")
            .eq("id", transaction_id)
            .eq("member_id", member_id)
            .single();

        if (!existing) {
            return res.status(404).json({
                success: false,
                error: "تراکنش یافت نشد یا دسترسی ندارید"
            });
        }

        if (existing.transaction_type !== "manual") {
            return res.status(400).json({
                success: false,
                error: "فقط تراکنش‌های دستی قابل حذف هستند"
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