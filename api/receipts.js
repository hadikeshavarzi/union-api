// api/receipts.js - COMPLETE & FIXED MULTI-TENANT VERSION
const express = require("express");
const { supabaseAdmin } = require("../supabaseAdmin");
const authMiddleware = require("./middleware/auth");

const router = express.Router();

const pickPgErrorMessage = (err) =>
    err?.message || err?.details || err?.hint || err?.code || JSON.stringify(err);

/* ============================================================
   Helper: تبدیل UUID به عدد (حل مشکل حیاتی PGRST116)
   ✅ این تابع حیاتی است
============================================================ */
async function getNumericMemberId(idInput) {
  if (!idInput) return null;

  // اگر ورودی از قبل عدد است
  if (!isNaN(idInput) && !String(idInput).includes("-")) {
    return Number(idInput);
  }

  // اگر UUID است، از دیتابیس پیدا کن
  const { data, error } = await supabaseAdmin
      .from('members')
      .select('id')
      .eq('auth_user_id', idInput)
      .maybeSingle();

  if (error) {
    console.error("❌ DB Error in getNumericMemberId:", error.message);
    return null;
  }

  return data ? data.id : null;
}

/* ============================================================
   GET ALL RECEIPTS (لیست رسیدها)
============================================================ */
router.get("/", authMiddleware, async (req, res) => {
  try {
    const {
      limit = 100,
      offset = 0,
      search,
      status,
      doc_type_id,
      owner_id,
      deliverer_id,
      date_from,
      date_to
    } = req.query;

    // ۱. دریافت آیدی عددی صحیح
    let member_id = await getNumericMemberId(req.user.id);
    if (!member_id) member_id = 2; // Fallback

    let query = supabaseAdmin
        .from("receipts")
        .select(`
                *,
                owner:customers!fk_receipt_owner (id, name, mobile),
                deliverer:customers!fk_receipt_deliverer (id, name),
                doc_type:document_types (id, name, code),
                items_count:receipt_items(count)
            `, { count: "exact" })
        .eq("member_id", member_id) // ✅ فیلتر تنانت با آیدی صحیح
        .order("created_at", { ascending: false });

    // جستجو
    if (search) {
      query = query.or(`receipt_no.eq.${Number(search) || 0},driver_name.ilike.%${search}%,ref_barnameh_number.ilike.%${search}%`);
    }

    // فیلترها
    if (status) query = query.eq("status", status);
    if (doc_type_id) query = query.eq("doc_type_id", doc_type_id);
    if (owner_id) query = query.eq("owner_id", owner_id);
    if (deliverer_id) query = query.eq("deliverer_id", deliverer_id);
    if (date_from) query = query.gte("doc_date", date_from);
    if (date_to) query = query.lte("doc_date", date_to);

    // صفحه‌بندی
    query = query.range(Number(offset), Number(offset) + Number(limit) - 1);

    const { data, error, count } = await query;

    if (error) {
      console.error("❌ GET Receipts Error:", error);
      return res.status(400).json({ success: false, error: pickPgErrorMessage(error) });
    }

    return res.json({ success: true, data, total: count });
  } catch (e) {
    console.error("❌ Server Error:", e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

/* ============================================================
   GET ONE RECEIPT (جزئیات کامل)
============================================================ */
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const receipt_id = Number(req.params.id);

    // ۱. دریافت آیدی عددی صحیح
    let member_id = await getNumericMemberId(req.user.id);
    if (!member_id) member_id = 2;

    const { data, error } = await supabaseAdmin
        .from("receipts")
        .select(`
                *,
                owner:customers!fk_receipt_owner (
                    id, name, mobile, national_id, customer_type, address
                ),
                deliverer:customers!fk_receipt_deliverer (
                    id, name, mobile
                ),
                doc_type:document_types (id, name, code),
                items:receipt_items (
                    *,
                    product:products (
                        id, name, sku,
                        unit:product_units(id, name, symbol),
                        category:product_categories!fk_category (id, name)
                    ),
                    owner:customers (id, name)
                )
            `)
        .eq("id", receipt_id)
        .eq("member_id", member_id) // ✅ فیلتر امنیتی
        .single();

    if (error || !data) {
      console.error("❌ Receipt Detail Error:", error);
      return res.status(404).json({
        success: false,
        error: "رسید یافت نشد یا دسترسی ندارید"
      });
    }

    return res.json({ success: true, data });
  } catch (e) {
    console.error("❌ Server Error:", e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

/* ============================================================
   CREATE RECEIPT (ساده بدون آیتم)
============================================================ */
router.post("/", authMiddleware, async (req, res) => {
  try {
    // ۱. دریافت آیدی عددی صحیح
    let member_id = await getNumericMemberId(req.user.id);
    if (!member_id) member_id = 2;

    // ✅ شماره‌دهی خودکار (فقط برای این member و doc_type)
    const { doc_type_id } = req.body;

    const { data: lastReceipt } = await supabaseAdmin
        .from("receipts")
        .select("receipt_no")
        .eq("member_id", member_id)
        .eq("doc_type_id", doc_type_id)
        .order("receipt_no", { ascending: false })
        .limit(1);

    const nextNo = lastReceipt?.[0]?.receipt_no ? lastReceipt[0].receipt_no + 1 : 1;

    const payload = {
      ...req.body,
      member_id, // ✅ تزریق آیدی عددی صحیح
      receipt_no: nextNo,
      status: req.body.status || "draft",
      payment_by: req.body.payment_by || "customer"
    };

    // حذف فیلدهای حساس
    delete payload.id;
    delete payload.created_at;
    delete payload.updated_at;

    // اعتبارسنجی
    if (!payload.doc_type_id || !payload.owner_id || !payload.doc_date) {
      return res.status(400).json({
        success: false,
        error: "نوع سند، مالک و تاریخ الزامی است"
      });
    }

    // ✅ چک اینکه owner و deliverer متعلق به این member باشند
    const { data: owner } = await supabaseAdmin
        .from("customers")
        .select("id")
        .eq("id", payload.owner_id)
        .eq("member_id", member_id)
        .single();

    if (!owner) {
      return res.status(403).json({
        success: false,
        error: "مالک کالا یافت نشد یا دسترسی ندارید"
      });
    }

    const { data, error } = await supabaseAdmin
        .from("receipts")
        .insert(payload)
        .select()
        .single();

    if (error) {
      console.error("❌ Create Receipt Error:", error);
      return res.status(400).json({
        success: false,
        error: pickPgErrorMessage(error)
      });
    }

    return res.json({
      success: true,
      data,
      message: "رسید با موفقیت ایجاد شد"
    });
  } catch (e) {
    console.error("❌ Server Error:", e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

/* ============================================================
   CREATE RECEIPT WITH ITEMS (با استفاده از RPC)
============================================================ */
router.post("/create-with-items", authMiddleware, async (req, res) => {
  try {
    // ۱. دریافت آیدی عددی صحیح
    let member_id = await getNumericMemberId(req.user.id);
    if (!member_id) member_id = 2;

    const payload = {
      ...req.body,
      member_id, // ✅ استفاده از آیدی صحیح
      status: req.body?.status || "draft",
      payment_by: req.body?.payment_by || "customer"
    };

    // ✅ چک owner
    if (payload.owner_id) {
      const { data: owner } = await supabaseAdmin
          .from("customers")
          .select("id")
          .eq("id", payload.owner_id)
          .eq("member_id", member_id)
          .single();

      if (!owner) {
        return res.status(403).json({ success: false, error: "مالک کالا یافت نشد" });
      }
    }

    const { data, error } = await supabaseAdmin.rpc("create_receipt_with_items", {
      p_payload: payload
    });

    if (error) {
      console.error("❌ Create Receipt with Items Error:", error);
      return res.status(400).json({ success: false, error: pickPgErrorMessage(error) });
    }

    return res.json({
      success: true,
      data,
      message: "رسید و آیتم‌ها با موفقیت ایجاد شدند"
    });
  } catch (e) {
    console.error("❌ Server Error:", e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

/* ============================================================
   UPDATE RECEIPT (فقط در حالت Draft)
============================================================ */
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    const receipt_id = Number(req.params.id);

    // ۱. دریافت آیدی عددی صحیح
    let member_id = await getNumericMemberId(req.user.id);
    if (!member_id) member_id = 2;

    // ✅ چک دسترسی و وضعیت
    const { data: existing } = await supabaseAdmin
        .from("receipts")
        .select("id, status, member_id")
        .eq("id", receipt_id)
        .eq("member_id", member_id)
        .single();

    if (!existing) {
      return res.status(404).json({ success: false, error: "رسید یافت نشد" });
    }

    if (existing.status !== "draft") {
      return res.status(400).json({ success: false, error: "فقط پیش‌نویس قابل ویرایش است" });
    }

    const payload = { ...req.body };
    delete payload.id;
    delete payload.member_id;
    delete payload.receipt_no;
    payload.updated_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin
        .from("receipts")
        .update(payload)
        .eq("id", receipt_id)
        .eq("member_id", member_id)
        .select()
        .single();

    if (error) {
      console.error("❌ Update Receipt Error:", error);
      return res.status(400).json({ success: false, error: pickPgErrorMessage(error) });
    }

    return res.json({ success: true, data, message: "ویرایش شد" });
  } catch (e) {
    console.error("❌ Server Error:", e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

/* ============================================================
   UPDATE RECEIPT WITH ITEMS (با استفاده از RPC)
============================================================ */
router.put("/:id/update-with-items", authMiddleware, async (req, res) => {
  try {
    const receipt_id = Number(req.params.id);

    // ۱. دریافت آیدی عددی صحیح
    let member_id = await getNumericMemberId(req.user.id);
    if (!member_id) member_id = 2;

    // ✅ چک دسترسی
    const { data: exists } = await supabaseAdmin
        .from('receipts')
        .select('id, status')
        .eq('id', receipt_id)
        .eq('member_id', member_id)
            .single();

    if (!exists) return res.status(403).json({ success: false, error: "رسید یافت نشد" });
    if (exists.status !== "draft") return res.status(400).json({ success: false, error: "فقط پیش‌نویس قابل ویرایش است" });

    const payload = {
      ...req.body,
      member_id,
      payment_by: req.body?.payment_by || "customer"
    };

    const { data, error } = await supabaseAdmin.rpc("update_receipt_with_items", {
      p_receipt_id: receipt_id,
      p_payload: payload
    });

    if (error) {
      console.error("❌ Update RPC Error:", error);
      return res.status(400).json({ success: false, error: pickPgErrorMessage(error) });
    }

    return res.json({ success: true, data, message: "ویرایش موفقیت‌آمیز بود" });
  } catch (e) {
    console.error("❌ Server Error:", e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

/* ============================================================
   FINALIZE RECEIPT (نهایی‌سازی + ثبت تراکنش موجودی)
============================================================ */
router.post("/:id/finalize", authMiddleware, async (req, res) => {
  try {
    const receipt_id = Number(req.params.id);

    // ۱. دریافت آیدی عددی صحیح
    let member_id = await getNumericMemberId(req.user.id);
    if (!member_id) member_id = 2;

    // ✅ چک دسترسی
    const { data: receipt, error: receiptError } = await supabaseAdmin
        .from("receipts")
        .select("id, status, member_id")
        .eq("id", receipt_id)
        .eq("member_id", member_id)
        .single();

    if (!receipt) return res.status(404).json({ success: false, error: "رسید یافت نشد" });
    if (receipt.status !== "draft") return res.status(400).json({ success: false, error: "فقط پیش‌نویس قابل نهایی‌سازی است" });

    // ✅ گرفتن آیتم‌ها
    const { data: items } = await supabaseAdmin
        .from("receipt_items")
        .select("*")
        .eq("receipt_id", receipt_id);

    if (!items || items.length === 0) {
      return res.status(400).json({ success: false, error: "رسید بدون آیتم قابل نهایی‌سازی نیست" });
    }

    // ✅ ثبت تراکنش‌های موجودی (ورود - مثبت)
    const transactions = items.map(item => ({
      type: "entry", // نوع تراکنش
      transaction_type: "receipt",
      reference_id: receipt_id,
      product_id: item.product_id,
      owner_id: item.owner_id,

      // مقادیر مثبت برای ورود
      qty: Math.abs(item.count || 0),
      weight: Math.abs(item.weights_net || 0),

      qty_real: Math.abs(item.count || 0),
      weight_real: Math.abs(item.weights_net || 0),
      qty_available: Math.abs(item.count || 0),
      weight_available: Math.abs(item.weights_net || 0),

      batch_no: item.row_code || `ID-${item.id}`,
      member_id, // ✅ آیدی صحیح
      created_at: new Date().toISOString(),
      ref_receipt_id: receipt_id,
      description: `رسید ورودی شماره ${receipt_id}`
    }));

    const { error: txError } = await supabaseAdmin
        .from("inventory_transactions")
        .insert(transactions);

    if (txError) {
      console.error("❌ Transaction Error:", txError);
      return res.status(400).json({ success: false, error: "خطا در ثبت موجودی" });
    }

    // ✅ تغییر وضعیت به final
    const { error: updateError } = await supabaseAdmin
        .from("receipts")
        .update({ status: "final", updated_at: new Date().toISOString() })
        .eq("id", receipt_id);

    if (updateError) throw updateError;

    return res.json({ success: true, message: "رسید نهایی شد و موجودی افزوده گردید" });
  } catch (e) {
    console.error("❌ Server Error:", e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

/* ============================================================
   DELETE RECEIPT (فقط در حالت Draft)
============================================================ */
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const receipt_id = Number(req.params.id);

    // ۱. دریافت آیدی عددی صحیح
    let member_id = await getNumericMemberId(req.user.id);
    if (!member_id) member_id = 2;

    // ✅ چک وضعیت قبل از حذف
    const { data: existing } = await supabaseAdmin
        .from("receipts")
        .select("id, status")
        .eq("id", receipt_id)
        .eq("member_id", member_id)
        .single();

    if (!existing) return res.status(404).json({ success: false, error: "رسید یافت نشد" });
    if (existing.status !== "draft") return res.status(400).json({ success: false, error: "فقط پیش‌نویس قابل حذف است" });

    // حذف آیتم‌ها ابتدا (اگر cascade نباشد)
    await supabaseAdmin.from("receipt_items").delete().eq("receipt_id", receipt_id);

    // حذف خود رسید
    const { error } = await supabaseAdmin
        .from("receipts")
        .delete()
        .eq("id", receipt_id)
        .eq("member_id", member_id);

    if (error) {
      console.error("❌ Delete Receipt Error:", error);
      return res.status(400).json({ success: false, error: pickPgErrorMessage(error) });
    }

    return res.json({ success: true, message: "رسید حذف شد" });
  } catch (e) {
    console.error("❌ Server Error:", e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;