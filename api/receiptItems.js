// api/receiptItems.js - COMPLETE MULTI-TENANT VERSION
const express = require("express");
const { supabaseAdmin } = require("../supabaseAdmin");
const authMiddleware = require("./middleware/auth");

const router = express.Router();

/* ============================================================
   Allowed columns
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

/* ============================================================
   GET ALL RECEIPT ITEMS (لیست آیتم‌ها)
============================================================ */
// api/receiptItems.js - SECURE VERSION با چک دوباره

/* ============================================================
   GET ALL RECEIPT ITEMS - نسخه امن
============================================================ */
router.get("/", authMiddleware, async (req, res) => {
  try {
    const { receipt_id, owner_id, product_id, limit = 500, offset = 0 } = req.query;
    const member_id = req.user.id;

    // اگر receipt_id داده شده، اول چک کنیم member دسترسی داره
    if (receipt_id) {
      const { data: receipt } = await supabaseAdmin
          .from("receipts")
          .select("id")
          .eq("id", receipt_id)
          .eq("member_id", member_id) // ✅ چک تنانت
          .single();

      if (!receipt) {
        return res.status(403).json({
          success: false,
          error: "رسید یافت نشد یا دسترسی ندارید"
        });
      }
    }

    // ✅ کوئری با inner join برای اطمینان از فیلتر کامل
    let query = supabaseAdmin
        .from("receipt_items")
        .select(`
                *,
                receipts!inner (
                    id,
                    receipt_no,
                    status,
                    member_id
                ),
                product:products!inner (  -- ✅ !inner اضافه شد
                    id,
                    name,
                    sku,
                    member_id,  -- ✅ برای چک اضافی
                    unit:product_units(id, name, symbol),
                    category:product_categories!fk_category (id, name)
                ),
                owner:customers!inner (  -- ✅ !inner اضافه شد
                    id, 
                    name,
                    member_id  -- ✅ برای چک اضافی
                )
            `, { count: "exact" })
        .eq("receipts.member_id", member_id)  // ✅ فیلتر از طریق receipt
        .eq("product.member_id", member_id)   // ✅ فیلتر از طریق product
        .eq("owner.member_id", member_id)     // ✅ فیلتر از طریق owner
        .order("id", { ascending: true });

    // فیلترهای اضافی
    if (receipt_id) query = query.eq("receipt_id", receipt_id);
    if (owner_id) query = query.eq("owner_id", owner_id);
    if (product_id) query = query.eq("product_id", product_id);

    // صفحه‌بندی
    query = query.range(Number(offset), Number(offset) + Number(limit) - 1);

    const { data, error, count } = await query;

    if (error) {
      console.error("❌ Receipt Items Error:", error);
      return res.status(400).json({ success: false, error: error.message });
    }

    // پاک کردن member_id از nested objects
    const cleanData = data?.map(({ receipts, product, owner, ...item }) => ({
      ...item,
      receipt_status: receipts?.status,
      receipt_no: receipts?.receipt_no,
      product: product ? {
        id: product.id,
        name: product.name,
        sku: product.sku,
        unit: product.unit,
        category: product.category
      } : null,
      owner: owner ? {
        id: owner.id,
        name: owner.name
      } : null
    })) || [];

    return res.json({ success: true, data: cleanData, total: count });
  } catch (e) {
    console.error("❌ Server Error:", e);
    return res.status(500).json({ success: false, error: "خطای داخلی سرور" });
  }
});

/* ============================================================
   GET ONE - با چک سه‌لایه امنیتی
============================================================ */
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const item_id = Number(req.params.id);
    const member_id = req.user.id;

    const { data, error } = await supabaseAdmin
        .from("receipt_items")
        .select(`
                *,
                receipts!inner (
                    id,
                    receipt_no,
                    status,
                    member_id
                ),
                product:products!inner (
                    id,
                    name,
                    sku,
                    member_id,
                    unit:product_units(id, name, symbol),
                    category:product_categories!fk_category (id, name)
                ),
                owner:customers!inner (
                    id, 
                    name, 
                    mobile,
                    member_id
                )
            `)
        .eq("id", item_id)
        .eq("receipts.member_id", member_id)   // ✅ چک receipt
        .eq("product.member_id", member_id)    // ✅ چک product
        .eq("owner.member_id", member_id)      // ✅ چک owner
        .single();

    if (error || !data) {
      return res.status(404).json({
        success: false,
        error: "آیتم یافت نشد یا دسترسی ندارید"
      });
    }

    // پاک کردن member_id از response
    const cleanData = {
      ...data,
      product: data.product ? {
        id: data.product.id,
        name: data.product.name,
        sku: data.product.sku,
        unit: data.product.unit,
        category: data.product.category
      } : null,
      owner: data.owner ? {
        id: data.owner.id,
        name: data.owner.name,
        mobile: data.owner.mobile
      } : null
    };
    delete cleanData.receipts;

    return res.json({ success: true, data: cleanData });
  } catch (e) {
    console.error("❌ Server Error:", e);
    return res.status(500).json({ success: false, error: "خطای داخلی سرور" });
  }
});

/* ============================================================
   CREATE RECEIPT ITEM (فقط در حالت Draft)
============================================================ */
router.post("/", authMiddleware, async (req, res) => {
  try {
    const clean = sanitize(req.body, CREATE_FIELDS);
    const member_id = req.user.id;

    // اعتبارسنجی
    if (!clean.receipt_id || !clean.product_id) {
      return res.status(400).json({
        success: false,
        error: "receipt_id و product_id الزامی است"
      });
    }

    // ✅ چک دسترسی به receipt و وضعیت draft
    const { data: receipt, error: rErr } = await supabaseAdmin
        .from("receipts")
        .select("id, status, member_id")
        .eq("id", clean.receipt_id)
        .eq("member_id", member_id) // ✅ فیلتر تنانت
        .single();

    if (rErr || !receipt) {
      return res.status(403).json({
        success: false,
        error: "رسید یافت نشد یا دسترسی ندارید"
      });
    }

    if (receipt.status !== "draft") {
      return res.status(400).json({
        success: false,
        error: "رسید نهایی شده و قابل ویرایش نیست",
      });
    }

    // ✅ چک product متعلق به این member باشه
    const { data: product } = await supabaseAdmin
        .from("products")
        .select("id")
        .eq("id", clean.product_id)
        .eq("member_id", member_id)
        .single();

    if (!product) {
      return res.status(403).json({
        success: false,
        error: "محصول یافت نشد یا دسترسی ندارید"
      });
    }

    // ✅ چک owner (اگر owner_id داده شده)
    if (clean.owner_id) {
      const { data: owner } = await supabaseAdmin
          .from("customers")
          .select("id")
          .eq("id", clean.owner_id)
          .eq("member_id", member_id)
          .single();

      if (!owner) {
        return res.status(403).json({
          success: false,
          error: "مالک کالا یافت نشد یا دسترسی ندارید"
        });
      }
    }

    const { data, error } = await supabaseAdmin
        .from("receipt_items")
        .insert(clean)
        .select()
        .single();

    if (error) {
      console.error("❌ Insert Item Error:", error);
      return res.status(400).json({ success: false, error: error.message });
    }

    return res.json({
      success: true,
      data,
      message: "آیتم با موفقیت اضافه شد"
    });
  } catch (e) {
    console.error("❌ Server Error:", e);
    return res.status(500).json({ success: false, error: "خطای داخلی سرور" });
  }
});

/* ============================================================
   UPDATE RECEIPT ITEM (فقط در حالت Draft)
============================================================ */
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const clean = sanitize(req.body, UPDATE_FIELDS);
    const member_id = req.user.id;

    if (!Object.keys(clean).length) {
      return res.status(400).json({
        success: false,
        error: "داده‌ای ارسال نشده"
      });
    }

    // ✅ گرفتن item با چک member_id
    const { data: item, error: itemError } = await supabaseAdmin
        .from("receipt_items")
        .select(`
                *,
                receipts!inner (
                    id,
                    status,
                    member_id
                )
            `)
        .eq("id", id)
        .eq("receipts.member_id", member_id) // ✅ فیلتر تنانت
        .single();

    if (itemError || !item) {
      return res.status(404).json({
        success: false,
        error: "آیتم یافت نشد یا دسترسی ندارید"
      });
    }

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

    if (error) {
      console.error("❌ Update Item Error:", error);
      return res.status(400).json({ success: false, error: error.message });
    }

    return res.json({
      success: true,
      data,
      message: "آیتم با موفقیت ویرایش شد"
    });
  } catch (e) {
    console.error("❌ Server Error:", e);
    return res.status(500).json({ success: false, error: "خطای داخلی سرور" });
  }
});

/* ============================================================
   DELETE RECEIPT ITEM (فقط در حالت Draft)
============================================================ */
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const member_id = req.user.id;

    // ✅ گرفتن item با چک member_id
    const { data: item, error: itemError } = await supabaseAdmin
        .from("receipt_items")
        .select(`
                *,
                receipts!inner (
                    id,
                    status,
                    member_id
                )
            `)
        .eq("id", id)
        .eq("receipts.member_id", member_id) // ✅ فیلتر تنانت
        .single();

    if (itemError || !item) {
      return res.status(404).json({
        success: false,
        error: "آیتم یافت نشد یا دسترسی ندارید"
      });
    }

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

    if (error) {
      console.error("❌ Delete Item Error:", error);
      return res.status(400).json({ success: false, error: error.message });
    }

    return res.json({
      success: true,
      message: "آیتم با موفقیت حذف شد"
    });
  } catch (e) {
    console.error("❌ Server Error:", e);
    return res.status(500).json({ success: false, error: "خطای داخلی سرور" });
  }
});

/* ============================================================
   BULK DELETE (حذف چندتایی)
============================================================ */
router.post("/bulk-delete", authMiddleware, async (req, res) => {
  try {
    const { ids } = req.body;
    const member_id = req.user.id;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        success: false,
        error: "آرایه ids الزامی است"
      });
    }

    // ✅ چک همه آیتم‌ها در یک receipt باشند و draft باشند
    const { data: items } = await supabaseAdmin
        .from("receipt_items")
        .select(`
                id,
                receipts!inner (status, member_id)
            `)
        .in("id", ids)
        .eq("receipts.member_id", member_id);

    if (!items || items.length !== ids.length) {
      return res.status(403).json({
        success: false,
        error: "برخی آیتم‌ها یافت نشدند یا دسترسی ندارید"
      });
    }

    const hasFinalReceipt = items.some(item => item.receipts.status !== "draft");
    if (hasFinalReceipt) {
      return res.status(400).json({
        success: false,
        error: "برخی آیتم‌ها متعلق به رسیدهای نهایی شده هستند"
      });
    }

    const { error } = await supabaseAdmin
        .from("receipt_items")
        .delete()
        .in("id", ids);

    if (error) {
      console.error("❌ Bulk Delete Error:", error);
      return res.status(400).json({ success: false, error: error.message });
    }

    return res.json({
      success: true,
      message: `${ids.length} آیتم با موفقیت حذف شدند`
    });
  } catch (e) {
    console.error("❌ Server Error:", e);
    return res.status(500).json({ success: false, error: "خطای داخلی سرور" });
  }
});

module.exports = router;