// api/products.js
const express = require("express");
const { supabaseAdmin } = require("../supabaseAdmin");
const { authMiddleware } = require("./middleware/auth");

const router = express.Router();

/* ============================================================
   GET ALL PRODUCTS (Public)
============================================================ */
router.get("/", async (req, res) => {
    try {
        const {
            limit = 500,
            offset = 0,
            search,
            category_id,
            is_active
        } = req.query;

        let query = supabaseAdmin
            .from("products")
            .select(`
                *,
                category:product_categories(*),
                unit:product_units(*)
            `, { count: "exact" })
            .order("id", { ascending: false });

        // Search
        if (search) {
            query = query.or(`name.ilike.%${search}%,code.ilike.%${search}%`);
        }

        // Filter by category
        if (category_id) {
            query = query.eq("category_id", category_id);
        }

        // Filter by active status
        if (is_active !== undefined) {
            query = query.eq("is_active", is_active === "true");
        }

        // Pagination
        query = query.range(Number(offset), Number(offset) + Number(limit) - 1);

        const { data, error, count } = await query;

        if (error) {
            return res.status(400).json({
                success: false,
                error: error.message
            });
        }

        return res.json({
            success: true,
            data,
            total: count,
            limit: Number(limit),
            offset: Number(offset)
        });

    } catch (e) {
        console.error("❌ Server Error:", e);
        return res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

/* ============================================================
   GET ONE PRODUCT (Public)
============================================================ */
router.get("/:id", async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from("products")
            .select(`
                *,
                category:product_categories(*),
                unit:product_units(*)
            `)
            .eq("id", req.params.id)
            .single();

        if (error || !data) {
            return res.status(404).json({
                success: false,
                error: "محصول یافت نشد"
            });
        }

        return res.json({ success: true, data });

    } catch (e) {
        return res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

/* ============================================================
   CREATE PRODUCT (Protected)
============================================================ */
router.post("/", authMiddleware, async (req, res) => {
    try {
        const body = req.body;

        if (!body.name || !body.category_id) {
            return res.status(400).json({
                success: false,
                error: "نام و دسته‌بندی محصول الزامی است"
            });
        }

        const { data, error } = await supabaseAdmin
            .from("products")
            .insert(body)
            .select()
            .single();

        if (error) {
            console.error("❌ Create Error:", error);
            return res.status(400).json({
                success: false,
                error: error.message
            });
        }

        return res.json({
            success: true,
            data,
            message: "محصول با موفقیت ایجاد شد"
        });

    } catch (e) {
        console.error("❌ Server Error:", e);
        return res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

/* ============================================================
   UPDATE PRODUCT (Protected)
============================================================ */
router.put("/:id", authMiddleware, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from("products")
            .update(req.body)
            .eq("id", req.params.id)
            .select()
            .single();

        if (error || !data) {
            return res.status(404).json({
                success: false,
                error: "محصول یافت نشد"
            });
        }

        return res.json({
            success: true,
            data,
            message: "محصول با موفقیت بروزرسانی شد"
        });

    } catch (e) {
        return res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

/* ============================================================
   PATCH PRODUCT (Protected)
============================================================ */
router.patch("/:id", authMiddleware, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from("products")
            .update(req.body)
            .eq("id", req.params.id)
            .select()
            .single();

        if (error || !data) {
            return res.status(404).json({
                success: false,
                error: "محصول یافت نشد"
            });
        }

        return res.json({ success: true, data });

    } catch (e) {
        return res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

/* ============================================================
   DELETE PRODUCT (Protected)
============================================================ */
router.delete("/:id", authMiddleware, async (req, res) => {
    try {
        const productId = req.params.id;

        // چک تراکنش
        const { data: txn } = await supabaseAdmin
            .from("inventory_transactions")
            .select("id")
            .eq("product_id", productId)
            .limit(1);

        if (txn && txn.length > 0) {
            return res.status(409).json({
                success: false,
                error: "امکان حذف این محصول وجود ندارد",
                message: "این محصول دارای تراکنش موجودی است"
            });
        }

        // حذف
        const { error } = await supabaseAdmin
            .from("products")
            .delete()
            .eq("id", productId);

        if (error) {
            console.error("❌ Delete Error:", error);
            return res.status(400).json({
                success: false,
                error: error.message,
            });
        }

        return res.json({
            success: true,
            message: "محصول با موفقیت حذف شد"
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