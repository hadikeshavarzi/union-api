// ===============================================
//  api/receiptItems.js  (FINAL - SAFE & CONSISTENT)
// ===============================================

const express = require("express");
const { supabaseAdmin } = require("../supabaseAdmin");
const { authMiddleware } = require("./middleware/auth");

const router = express.Router();

/* ============================================================
   Allowed columns
   ⛔ receipt_id فقط در CREATE
============================================================ */
const CREATE_FIELDS = [
  "receipt_id",
  "product_id",
  "owner_id",

  "is_parent",
  "parent_id",
  "parent_row",
  "row_code",

  "national_product_id",
  "product_description",

  "count",
  "production_type",
  "is_used",
  "is_defective",

  "weights_full",
  "weights_empty",
  "weights_net",
  "weights_origin",
  "weights_diff",

  "dim_length",
  "dim_width",
  "dim_thickness",

  "heat_number",
  "bundle_no",
  "brand",
  "order_no",
  "depo_location",
  "description_notes",
];

const UPDATE_FIELDS = CREATE_FIELDS.filter(f => f !== "receipt_id");

/* ============================================================
   Helpers
============================================================ */
const sanitize = (body, fields) =>
  Object.fromEntries(Object.entries(body).filter(([k]) => fields.includes(k)));

async function getItemWithReceipt(id) {
  const { data, error } = await supabaseAdmin
    .from("receipt_items")
    .select(`
      *,
      receipts (
        id,
        status
      )
    `)
    .eq("id", id)
    .single();

  if (error) throw error;
  return data;
}

/* ============================================================
   GET ALL
============================================================ */
router.get("/", authMiddleware, async (req, res) => {
  try {
    const { receipt_id, owner_id } = req.query;

    let q = supabaseAdmin
      .from("receipt_items")
      .select(`
        *,
        products (
          id,
          name,
          unit,
          category_id,
          product_categories (
            id,
            name
          )
        )
      `)
      .order("id", { ascending: true });

    if (receipt_id) q = q.eq("receipt_id", receipt_id);
    if (owner_id) q = q.eq("owner_id", owner_id);

    const { data, error } = await q;
    if (error) return res.status(400).json({ success: false, error: error.message });

    return res.json({ success: true, data });
  } catch (e) {
    return res.status(500).json({ success: false, error: "خطای داخلی سرور" });
  }
});

/* ============================================================
   CREATE ITEM (ONLY IF receipt = draft)
============================================================ */
router.post("/", authMiddleware, async (req, res) => {
  try {
    const clean = sanitize(req.body, CREATE_FIELDS);

    if (!clean.receipt_id || !clean.product_id) {
      return res.status(400).json({ success: false, error: "اطلاعات ناقص است" });
    }

    const { data: receipt, error: rErr } = await supabaseAdmin
      .from("receipts")
      .select("status")
      .eq("id", clean.receipt_id)
      .single();

    if (rErr) return res.status(400).json({ success: false, error: rErr.message });
    if (receipt.status !== "draft") {
      return res.status(400).json({
        success: false,
        error: "رسید نهایی شده و قابل ویرایش نیست",
      });
    }

    const { data, error } = await supabaseAdmin
      .from("receipt_items")
      .insert(clean)
      .select()
      .single();

    if (error) return res.status(400).json({ success: false, error: error.message });

    return res.json({ success: true, data });
  } catch (e) {
    return res.status(500).json({ success: false, error: "خطای داخلی سرور" });
  }
});

/* ============================================================
   UPDATE ITEM (ONLY IF receipt = draft)
============================================================ */
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const clean = sanitize(req.body, UPDATE_FIELDS);

    if (!Object.keys(clean).length) {
      return res.status(400).json({ success: false, error: "داده‌ای ارسال نشده" });
    }

    const item = await getItemWithReceipt(id);

    if (item.receipts.status !== "draft") {
      return res.status(400).json({
        success: false,
        error: "رسید نهایی شده و قابل ویرایش نیست",
      });
    }

    const { data, error } = await supabaseAdmin
      .from("receipt_items")
      .update(clean)
      .eq("id", id)
      .select()
      .single();

    if (error) return res.status(400).json({ success: false, error: error.message });

    return res.json({ success: true, data });
  } catch (e) {
    return res.status(500).json({ success: false, error: "خطای داخلی سرور" });
  }
});

/* ============================================================
   DELETE ITEM (ONLY IF receipt = draft)
============================================================ */
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const item = await getItemWithReceipt(id);

    if (item.receipts.status !== "draft") {
      return res.status(400).json({
        success: false,
        error: "رسید نهایی شده و قابل حذف نیست",
      });
    }

    const { error } = await supabaseAdmin
      .from("receipt_items")
      .delete()
      .eq("id", id);

    if (error) return res.status(400).json({ success: false, error: error.message });

    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: "خطای داخلی سرور" });
  }
});

module.exports = router;
