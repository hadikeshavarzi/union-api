// api/inventoryStock.js - MULTI-TENANT
const express = require("express");
const { supabaseAdmin } = require("../supabaseAdmin");
const authMiddleware = require("./middleware/auth");

const router = express.Router();

/* ============================================================
   GET INVENTORY STOCK (موجودی انبار)
   نکته: این جدول view است و باید از inventory_transactions محاسبه شود
============================================================ */
router.get("/", authMiddleware, async (req, res) => {
    try {
        const { product_id, owner_id } = req.query;
        const member_id = req.user.id;

        // اگر view خودتون member_id نداره، باید از products یا transactions بگیریم
        // روش 1: اگر inventorystock یک view ساده است بدون member_id
        // باید از طریق join با products فیلتر کنیم

        let query = supabaseAdmin
            .from("inventorystock")
            .select(`
                *,
                product:products!inner (
                    id,
                    name,
                    sku,
                    member_id,
                    unit:product_units (name, symbol)
                ),
                owner:customers!inner (
                    id,
                    name,
                    member_id
                )
            `)
            .eq("product.member_id", member_id) // ✅ فیلتر از طریق product
            .eq("owner.member_id", member_id); // ✅ فیلتر از طریق owner

        if (product_id) {
            query = query.eq("product_id", product_id);
        }

        if (owner_id) {
            query = query.eq("owner_id", owner_id);
        }

        const { data, error } = await query;

        if (error) {
            console.error("❌ Inventory Stock Error:", error);
            return res.status(400).json({ success: false, error: error.message });
        }

        // پاک کردن nested objects اضافی
        const cleanData = data?.map(item => ({
            product_id: item.product_id,
            owner_id: item.owner_id,
            qty_in: item.qty_in,
            weight_in: item.weight_in,
            qty_out: item.qty_out,
            weight_out: item.weight_out,
            qty_on_hand: item.qty_on_hand,
            weight_on_hand: item.weight_on_hand,
            product: item.product,
            owner: item.owner
        })) || [];

        return res.json({ success: true, data: cleanData });
    } catch (e) {
        console.error("❌ Server Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   GET STOCK BY PRODUCT AND OWNER (موجودی دقیق)
============================================================ */
router.get("/by-product-owner", authMiddleware, async (req, res) => {
    try {
        const { product_id, owner_id } = req.query;
        const member_id = req.user.id;

        if (!product_id || !owner_id) {
            return res.status(400).json({
                success: false,
                error: "product_id و owner_id الزامی است"
            });
        }

        // استفاده از RPC function
        const { data, error } = await supabaseAdmin.rpc("get_stock", {
            p_product_id: Number(product_id),
            p_owner_id: Number(owner_id),
            p_member_id: member_id // ✅ پاس دادن member_id به function
        });

        if (error) {
            console.error("❌ RPC Error:", error);
            return res.status(400).json({ success: false, error: error.message });
        }

        return res.json({ success: true, data: data || 0 });
    } catch (e) {
        console.error("❌ Server Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;