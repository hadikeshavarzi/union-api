const express = require("express");
const { supabaseAdmin } = require("../supabaseAdmin");

const router = express.Router();

// CREATE ITEM
router.post("/", async (req, res) => {
    try {
        const {
            clearance_id,
            parentRowCode,
            qty,
            weight,
        } = req.body;

        // ---------- 1) یافتن ردیف مادر ----------
        const { data: parentRows, error: parentErr } = await supabaseAdmin
            .from("receiptitems")
            .select("*, product(*), owner(*)")
            .eq("row", parentRowCode)
            .limit(1);

        if (parentErr) return res.status(400).json({ error: parentErr });
        if (!parentRows || parentRows.length === 0)
            return res.status(404).json({ error: `ردیف ${parentRowCode} یافت نشد` });

        const parent = parentRows[0];

        // استخراج شناسه‌ها
        const productId = parent.product?.id || parent.product;
        const ownerId = parent.owner?.id || parent.owner;
        const categoryId = parent.product?.category || null;

        // ---------- 2) موجودی کالا ----------
        const { data: stockRows } = await supabaseAdmin
            .from("inventorystock")
            .select("*")
            .eq("product", productId)
            .eq("owner", ownerId)
            .limit(1);

        if (!stockRows || stockRows.length === 0)
            return res.status(400).json({ error: "موجودی برای کالا یافت نشد" });

        const stock = stockRows[0];

        const availableQty = Number(stock.qtyOnHand || 0);
        const availableWeight = Number(stock.weightOnHand || 0);

        // ---------- 3) Validation ----------
        if (qty > availableQty)
            return res.status(400).json({
                error: `تعداد درخواستی (${qty}) بیشتر از موجودی (${availableQty}) است`,
            });

        if (weight > availableWeight)
            return res.status(400).json({
                error: `وزن درخواستی (${weight}) بیشتر از موجودی (${availableWeight}) است`,
            });

        // ---------- 4) تولید newRowCode ----------
        const { data: children } = await supabaseAdmin
            .from("clearance_items")
            .select("new_row_code")
            .eq("parent_row_code", parentRowCode)
            .order("new_row_code", { ascending: false })
            .limit(1);

        let nextChildNumber = 1;

        if (children && children.length > 0) {
            const parts = children[0].new_row_code.split("/");
            const lastNum = parseInt(parts[1] || "0", 10);
            nextChildNumber = lastNum + 1;
        }

        const newRowCode = `${parentRowCode}/${nextChildNumber}`;

        // ---------- 5) INSERT ----------
        const { data: inserted, error: insertErr } = await supabaseAdmin
            .from("clearance_items")
            .insert({
                clearance_id,
                parent_row_code: parentRowCode,
                new_row_code: newRowCode,

                category_id: categoryId,
                product_id: productId,
                owner_id: ownerId,

                available_qty: availableQty,
                available_weight: availableWeight,

                qty,
                weight
            })
            .select()
            .single();

        if (insertErr) return res.status(400).json({ error: insertErr });

        return res.json({
            success: true,
            item: inserted,
        });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Internal server error" });
    }
});

module.exports = router;
