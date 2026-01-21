// api/productUnits.js
const express = require("express");
const { supabaseAdmin } = require("../supabaseAdmin");

// 👇 اصلاح شد: حذف {} و اصلاح مسیر به ../middleware/auth
const authMiddleware = require("./middleware/auth");

const router = express.Router();

/* ============================================================================
   📌 GET ALL – دریافت همه واحدها (Public)
============================================================================ */
router.get("/", async (req, res) => {
    try {
        const { limit = 100, search } = req.query;

        let query = supabaseAdmin
            .from("product_units")
            .select("*", { count: "exact" })
            .order("id", { ascending: true });

        // Search
        if (search) {
            query = query.or(`name.ilike.%${search}%,symbol.ilike.%${search}%`);
        }

        // Limit
        if (limit) {
            query = query.limit(Number(limit));
        }

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
   📌 GET ONE – دریافت یک واحد (Public)
============================================================================ */
router.get("/:id", async (req, res) => {
    try {
        const { id } = req.params;

        const { data, error } = await supabaseAdmin
            .from("product_units")
            .select("*")
            .eq("id", id)
            .single();

        if (error) {
            return res.status(404).json({
                success: false,
                error: "واحد یافت نشد"
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

/* ============================================================================
   📌 CREATE – ایجاد واحد جدید (Protected)
============================================================================ */
router.post("/", authMiddleware, async (req, res) => {
    try {
        const body = req.body;

        if (!body.name || !body.symbol) {
            return res.status(400).json({
                success: false,
                error: "نام و نماد واحد الزامی است"
            });
        }

        const { data, error } = await supabaseAdmin
            .from("product_units")
            .insert(body)
            .select()
            .single();

        if (error) {
            console.error("❌ Insert Error:", error);
            return res.status(400).json({
                success: false,
                error: error.message
            });
        }

        return res.json({
            success: true,
            data,
            message: "واحد با موفقیت ایجاد شد"
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
   📌 UPDATE – ویرایش واحد (Protected)
============================================================================ */
router.put("/:id", authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const body = req.body;

        const { data, error } = await supabaseAdmin
            .from("product_units")
            .update(body)
            .eq("id", id)
            .select()
            .single();

        if (error) {
            console.error("❌ Update Error:", error);
            return res.status(400).json({
                success: false,
                error: error.message
            });
        }

        return res.json({
            success: true,
            data,
            message: "واحد با موفقیت بروزرسانی شد"
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
   📌 DELETE – حذف واحد (Protected)
============================================================================ */
router.delete("/:id", authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;

        const { error } = await supabaseAdmin
            .from("product_units")
            .delete()
            .eq("id", id);

        // Foreign key violation
        if (error?.code === "23503") {
            return res.status(409).json({
                success: false,
                error: "امکان حذف این واحد وجود ندارد",
                message: "این واحد در محصولات استفاده شده است"
            });
        }

        if (error) {
            console.error("❌ Delete Error:", error);
            return res.status(400).json({
                success: false,
                error: error.message
            });
        }

        return res.json({
            success: true,
            message: "واحد با موفقیت حذف شد"
        });

    } catch (e) {
        console.error("❌ Server Error:", e);
        return res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

module.exports = router;