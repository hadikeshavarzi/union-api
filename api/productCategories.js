// api/productCategories.js
const express = require("express");
const { supabaseAdmin } = require("../supabaseAdmin");
const { authMiddleware } = require("./middleware/auth");

const router = express.Router();

/* =====================================================================
   UTIL: Normalize
===================================================================== */
function normalizeCategory(body) {
    return {
        name: body.name,
        slug: body.slug,
        parent_id: body.parent_id || null,
        description: body.description || "",
        image_id: body.image_id || null,
        is_active: body.is_active ?? true,
        sort_order: body.sort_order ?? 0,
        storage_cost: body.storage_cost ?? null,
        loading_cost: body.loading_cost ?? null,
    };
}

/* =====================================================================
   GET ALL CATEGORIES (Public)
===================================================================== */
router.get("/", async (req, res) => {
    try {
        const { limit = 500, search, parent_id } = req.query;

        let query = supabaseAdmin
            .from("product_categories")
            .select("*", { count: "exact" })
            .order("sort_order", { ascending: true });

        // Search
        if (search) {
            query = query.ilike("name", `%${search}%`);
        }

        // Filter by parent
        if (parent_id) {
            query = query.eq("parent_id", parent_id);
        }

        // Limit
        if (limit) {
            query = query.limit(Number(limit));
        }

        const { data, error, count } = await query;

        if (error) {
            return res.status(400).json({
                success: false,
                error: error.message,
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
            error: e.message,
        });
    }
});

/* =====================================================================
   GET ONE CATEGORY (Public)
===================================================================== */
router.get("/:id", async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from("product_categories")
            .select("*")
            .eq("id", req.params.id)
            .single();

        if (error) {
            return res.status(404).json({
                success: false,
                error: "دسته‌بندی یافت نشد",
            });
        }

        return res.json({ success: true, data });

    } catch (e) {
        return res.status(500).json({
            success: false,
            error: e.message,
        });
    }
});

/* =====================================================================
   CREATE CATEGORY (Protected)
===================================================================== */
router.post("/", authMiddleware, async (req, res) => {
    try {
        const payload = normalizeCategory(req.body);

        if (!payload.name) {
            return res.status(400).json({
                success: false,
                error: "نام دسته‌بندی الزامی است"
            });
        }

        const { data, error } = await supabaseAdmin
            .from("product_categories")
            .insert(payload)
            .select()
            .single();

        if (error) {
            console.log("❌ CREATE ERROR:", error);
            return res.status(400).json({
                success: false,
                error: error.message,
            });
        }

        return res.json({
            success: true,
            data,
            message: "دسته‌بندی با موفقیت ایجاد شد"
        });

    } catch (e) {
        console.error("❌ Server Error:", e);
        return res.status(500).json({
            success: false,
            error: e.message,
        });
    }
});

/* =====================================================================
   UPDATE CATEGORY (Protected)
===================================================================== */
router.put("/:id", authMiddleware, async (req, res) => {
    try {
        const payload = normalizeCategory(req.body);

        const { data, error } = await supabaseAdmin
            .from("product_categories")
            .update(payload)
            .eq("id", req.params.id)
            .select()
            .single();

        if (error) {
            console.log("❌ UPDATE ERROR:", error);
            return res.status(400).json({
                success: false,
                error: error.message,
            });
        }

        return res.json({
            success: true,
            data,
            message: "دسته‌بندی با موفقیت بروزرسانی شد"
        });

    } catch (e) {
        console.error("❌ Server Error:", e);
        return res.status(500).json({
            success: false,
            error: e.message,
        });
    }
});

/* =====================================================================
   PATCH CATEGORY (Protected)
===================================================================== */
router.patch("/:id", authMiddleware, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from("product_categories")
            .update(req.body)
            .eq("id", req.params.id)
            .select()
            .single();

        if (error) {
            return res.status(400).json({
                success: false,
                error: error.message
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

/* =====================================================================
   DELETE CATEGORY (Protected)
===================================================================== */
router.delete("/:id", authMiddleware, async (req, res) => {
    try {
        const id = req.params.id;

        const { error } = await supabaseAdmin
            .from("product_categories")
            .delete()
            .eq("id", id);

        // FK Error
        if (error?.code === "23503") {
            return res.status(409).json({
                success: false,
                error: "امکان حذف این دسته‌بندی وجود ندارد",
                message: "این دسته‌بندی در محصولات یا زیردسته‌ها استفاده شده است",
            });
        }

        if (error) {
            console.log("❌ DELETE ERROR:", error);
            return res.status(400).json({
                success: false,
                error: error.message,
            });
        }

        return res.json({
            success: true,
            message: "دسته‌بندی با موفقیت حذف شد"
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