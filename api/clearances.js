const express = require("express");
const { supabaseAdmin } = require("../supabaseAdmin");
const router = express.Router();

// GET ALL
router.get("/", async (req, res) => {
    const { data, error } = await supabaseAdmin
        .from("clearances")
        .select("*")
        .order("id", { ascending: false });

    if (error) return res.status(400).json({ error });
    return res.json(data);
});

// CREATE
router.post("/", async (req, res) => {
    const body = req.body;

    // شماره دهی
    const { data: last } = await supabaseAdmin
        .from("clearances")
        .select("clearance_no")
        .order("clearance_no", { ascending: false })
        .limit(1);

    body.clearance_no = last?.[0]?.clearance_no + 1 || 1;

    const { data, error } = await supabaseAdmin
        .from("clearances")
        .insert(body)
        .select()
        .single();

    if (error) return res.status(400).json({ error });
    return res.json({ success: true, data });
});

// FINALIZE (Draft → Final)
router.post("/:id/finalize", async (req, res) => {
    const id = req.params.id;

    // آیتم‌ها
    const { data: items } = await supabaseAdmin
        .from("clearance_items")
        .select("*")
        .eq("clearance_id", id);

    if (!items || items.length === 0)
        return res.status(400).json({ error: "هیچ آیتمی ثبت نشده است" });

    // ثبت تراکنش‌ها (ledger)
    for (const item of items) {
        await supabaseAdmin
            .from("inventory_transactions")
            .insert({
                type: "out",
                product_id: item.product_id,
                owner_id: item.owner_id,
                qty: item.qty,
                weight: item.weight,
                ref_receipt_id: null,    // چون سند خروج است
            });
    }

    // بروزرسانی وضعیت
    await supabaseAdmin
        .from("clearances")
        .update({ status: "final" })
        .eq("id", id);

    return res.json({ success: true });
});

// CANCEL (Final → Cancelled)
router.post("/:id/cancel", async (req, res) => {
    const id = req.params.id;

    // تراکنش‌های مربوطه را معکوس میکنیم (out → in)
    const { data: items } = await supabaseAdmin
        .from("clearance_items")
        .select("*")
        .eq("clearance_id", id);

    for (const item of items) {
        await supabaseAdmin
            .from("inventory_transactions")
            .insert({
                type: "in",
                product_id: item.product_id,
                owner_id: item.owner_id,
                qty: item.qty,
                weight: item.weight,
                ref_receipt_id: null,
            });
    }

    await supabaseAdmin
        .from("clearances")
        .update({ status: "cancelled" })
        .eq("id", id);

    return res.json({ success: true });
});

module.exports = router;
