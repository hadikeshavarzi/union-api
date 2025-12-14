// api/customers.js

const express = require("express");
const { supabaseAdmin } = require("../supabaseAdmin");
const { authMiddleware } = require("./middleware/auth");

const router = express.Router();

/* ============================================================================
   📌 GET ALL CUSTOMERS (Public - برای استفاده در فرم‌ها)
============================================================================ */
router.get("/", async (req, res) => {  // ❌ حذف authMiddleware
    try {
        const { limit = 1000, offset = 0, search } = req.query;

        let query = supabaseAdmin
            .from("customers")
            .select("*", { count: "exact" })
            .order("id", { ascending: false });

        if (search) {
            query = query.or(
                `name.ilike.%${search}%,mobile.ilike.%${search}%,national_id.ilike.%${search}%`
            );
        }

        query = query.range(Number(offset), Number(offset) + Number(limit) - 1);

        const { data, error, count } = await query;

        if (error) {
            console.error("❌ Fetch Error:", error);
            return res.status(400).json({
                success: false,
                error: error.message
            });
        }

        return res.json({
            success: true,
            data,
            total: count
        });

    } catch (e) {
        console.error("❌ Server Error:", e);
        return res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

/* ============================================================================
   📌 GET ONE CUSTOMER (Public)
============================================================================ */
router.get("/:id", async (req, res) => {  // ❌ حذف authMiddleware
    try {
        const { data, error } = await supabaseAdmin
            .from("customers")
            .select("*")
            .eq("id", req.params.id)
            .single();

        if (error) {
            console.error("❌ Fetch One Error:", error);
            return res.status(404).json({
                success: false,
                error: "مشتری یافت نشد"
            });
        }

        return res.json({ success: true, data });

    } catch (e) {
        console.error("❌ Server Error:", e);
        return res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

/* ============================================================================
   📌 CREATE CUSTOMER (Protected)
============================================================================ */
router.post("/", authMiddleware, async (req, res) => {  // ✅ نگه دار
    try {
        const { data, error } = await supabaseAdmin
            .from("customers")
            .insert(req.body)
            .select()
            .single();

        if (error) {
            console.error("❌ Create Error:", error);
            return res.status(400).json({
                success: false,
                error: error.message
            });
        }

        return res.json({ success: true, data });

    } catch (e) {
        console.error("❌ Server Error:", e);
        return res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

/* ============================================================================
   📌 UPDATE CUSTOMER (Protected)
============================================================================ */
router.put("/:id", authMiddleware, async (req, res) => {  // ✅ نگه دار
    try {
        const { data, error } = await supabaseAdmin
            .from("customers")
            .update(req.body)
            .eq("id", req.params.id)
            .select()
            .single();

        if (error) {
            console.error("❌ Update Error:", error);
            return res.status(400).json({
                success: false,
                error: error.message
            });
        }

        return res.json({ success: true, data });

    } catch (e) {
        console.error("❌ Server Error:", e);
        return res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

/* ============================================================================
   📌 DELETE CUSTOMER (Protected)
============================================================================ */
router.delete("/:id", authMiddleware, async (req, res) => {  // ✅ نگه دار
    try {
        const id = req.params.id;

        const { error } = await supabaseAdmin
            .from("customers")
            .delete()
            .eq("id", id);

        if (error?.code === "23503") {
            return res.status(409).json({
                success: false,
                error: "امکان حذف این مشتری وجود ندارد",
                message: "برای این مشتری سند یا رسید ثبت شده است."
            });
        }

        if (error) {
            return res.status(400).json({
                success: false,
                error: error.message,
            });
        }

        return res.json({
            success: true,
            message: "مشتری با موفقیت حذف شد"
        });

    } catch (e) {
        console.error("❌ Server Error:", e);
        return res.status(500).json({
            success: false,
            error: e.message,
        });
    }
});

module.exports = router;