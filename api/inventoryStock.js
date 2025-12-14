const express = require("express");
const { supabaseAdmin } = require("../supabaseAdmin");
const router = express.Router();

// GET stock for all or filtered
router.get("/", async (req, res) => {
    const { product_id, owner_id } = req.query;

    let query = supabaseAdmin
        .from("inventorystock")
        .select("*");

    if (product_id) query = query.eq("product_id", product_id);
    if (owner_id) query = query.eq("owner_id", owner_id);

    const { data, error } = await query;

    if (error) return res.status(400).json({ error });
    return res.json({ success: true, data });
});

module.exports = router;
