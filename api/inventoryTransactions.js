const express = require("express");
const { supabaseAdmin } = require("../supabaseAdmin");
const router = express.Router();

// Helper: get current stock for (product, owner)
async function getCurrentStock(product_id, owner_id) {
    const { data, error } = await supabaseAdmin.rpc("get_stock", {
        p_product_id: product_id,
        p_owner_id: owner_id,
    });

    if (error) {
        console.error("RPC Error:", error);
        return 0;
    }

    return data || 0;
}

// CREATE Transaction
router.post("/", async (req, res) => {
    const body = req.body;

    const { product_id, owner_id, qty, type } = body;

    // 1) موجودی فعلی
    const before = await getCurrentStock(product_id, owner_id);

    const after = type === "in"
        ? before + Number(qty)
        : before - Number(qty);

    body.snapshot_qty_before = before;
    body.snapshot_qty_after = after;

    // 2) ثبت تراکنش
    const { data, error } = await supabaseAdmin
        .from("inventory_transactions")
        .insert(body)
        .select()
        .single();

    if (error) return res.status(400).json({ error });

    return res.json({
        success: true,
        data,
    });
});

module.exports = router;
