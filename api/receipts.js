// ===============================================
//  api/receipts.js
//  Supabase (Admin) + Express
//  ATOMIC via PostgreSQL RPC
// ===============================================

const express = require("express");
const { supabaseAdmin } = require("../supabaseAdmin");
const { authMiddleware } = require("./middleware/auth");

const router = express.Router();

/* ------------------------------------------------
  Helpers
------------------------------------------------ */
const pickPgErrorMessage = (err) =>
  err?.message ||
  err?.details ||
  err?.hint ||
  err?.code ||
  JSON.stringify(err);

/* ============================================================
   GET ALL RECEIPTS
============================================================ */
router.get("/", authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("receipts")
      .select("*")
      .order("id", { ascending: false });

    if (error) {
      return res.status(400).json({
        success: false,
        error: pickPgErrorMessage(error),
      });
    }

    return res.json({ success: true, data });
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: e.message || "خطای داخلی سرور",
    });
  }
});

/* ============================================================
   GET ONE RECEIPT + ITEMS
============================================================ */
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const receipt_id = Number(req.params.id);
    if (!Number.isInteger(receipt_id)) {
      return res.status(400).json({
        success: false,
        error: "شناسه رسید نامعتبر است",
      });
    }

    const { data, error } = await supabaseAdmin
      .from("receipts")
      .select("*, receipt_items(*)")
      .eq("id", receipt_id)
      .single();

    if (error) {
      return res.status(404).json({
        success: false,
        error: pickPgErrorMessage(error),
      });
    }

    return res.json({ success: true, data });
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: e.message || "خطای داخلی سرور",
    });
  }
});

/* ============================================================
   CREATE RECEIPT (ATOMIC)
   RPC: create_receipt_with_items(jsonb)
============================================================ */
router.post("/create-with-items", authMiddleware, async (req, res) => {
  try {
    const member_id = req.user?.id;
    if (!member_id) {
      return res.status(401).json({
        success: false,
        error: "احراز هویت ناموفق",
      });
    }

    // فرانت گفتی همیشه customer است
    const payload = {
      ...req.body,
      member_id,
      payment_by: req.body?.payment_by || "customer",
    };

    const { data, error } = await supabaseAdmin.rpc(
      "create_receipt_with_items",
      { p_payload: payload }
    );

    if (error) {
      return res.status(400).json({
        success: false,
        error: pickPgErrorMessage(error),
      });
    }

    return res.json(data);
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: e.message || "خطای داخلی سرور",
    });
  }
});

/* ============================================================
   UPDATE RECEIPT (ATOMIC)
   RPC: update_receipt_with_items(bigint, jsonb)
============================================================ */
router.put("/:id/update-with-items", authMiddleware, async (req, res) => {
  try {
    const member_id = req.user?.id;
    if (!member_id) {
      return res.status(401).json({
        success: false,
        error: "احراز هویت ناموفق",
      });
    }

    const receipt_id = Number(req.params.id);
    if (!Number.isInteger(receipt_id)) {
      return res.status(400).json({
        success: false,
        error: "شناسه رسید نامعتبر است",
      });
    }

    const payload = {
      ...req.body,
      member_id,
      payment_by: req.body?.payment_by || "customer",
    };

    const { data, error } = await supabaseAdmin.rpc(
      "update_receipt_with_items",
      {
        p_receipt_id: receipt_id,
        p_payload: payload,
      }
    );

    if (error) {
      return res.status(400).json({
        success: false,
        error: pickPgErrorMessage(error),
      });
    }

    return res.json(data);
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: e.message || "خطای داخلی سرور",
    });
  }
});

/* ============================================================
   CANCEL RECEIPT (ATOMIC)
   RPC: cancel_receipt(bigint, bigint)
============================================================ */
router.post("/:id/cancel", authMiddleware, async (req, res) => {
  try {
    const member_id = req.user?.id;
    if (!member_id) {
      return res.status(401).json({
        success: false,
        error: "احراز هویت ناموفق",
      });
    }

    const receipt_id = Number(req.params.id);
    if (!Number.isInteger(receipt_id)) {
      return res.status(400).json({
        success: false,
        error: "شناسه رسید نامعتبر است",
      });
    }

    const { data, error } = await supabaseAdmin.rpc("cancel_receipt", {
      p_receipt_id: receipt_id,
      p_member_id: member_id,
    });

    if (error) {
      return res.status(400).json({
        success: false,
        error: pickPgErrorMessage(error),
      });
    }

    return res.json(data);
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: e.message || "خطای داخلی سرور",
    });
  }
});

module.exports = router;
