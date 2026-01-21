// api/documentTypes.js (نسخه کامل با Authentication)

const express = require("express");
const { supabaseAdmin } = require("../supabaseAdmin");
const  authMiddleware  = require("./middleware/auth"); // ✅ اضافه شد
const router = express.Router();

/* ============================================================
   GET ALL DOCUMENT TYPES (Public - بدون authentication)
============================================================ */
router.get("/", async (req, res) => {
    try {
        const { is_active } = req.query;

        let query = supabaseAdmin
            .from("document_types")
            .select("*")
            .order("code", { ascending: true });

        // فیلتر فعال/غیرفعال
        if (is_active === "true") {
            query = query.eq("is_active", true);
        }

        const { data, error } = await query;

        if (error) {
            console.error("❌ Error fetching document types:", error);
            return res.status(400).json({
                success: false,
                error: error.message
            });
        }

        return res.json({ success: true, data });

    } catch (e) {
        console.error("❌ Server error:", e);
        return res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

/* ============================================================
   GET ONE DOCUMENT TYPE (Public - بدون authentication)
============================================================ */
router.get("/:id", async (req, res) => {
    try {
        const id = req.params.id;

        const { data, error } = await supabaseAdmin
            .from("document_types")
            .select("*")
            .eq("id", id)
            .single();

        if (error) {
            return res.status(404).json({
                success: false,
                error: "نوع سند یافت نشد"
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
   CREATE DOCUMENT TYPE (Protected)
============================================================ */
router.post("/", authMiddleware, async (req, res) => {
    try {
        const { code, name, description, is_active } = req.body;

        if (!code || !name) {
            return res.status(400).json({
                success: false,
                error: "code و name الزامی هستند"
            });
        }

        // چک کردن تکراری نبودن code
        const { data: existing } = await supabaseAdmin
            .from("document_types")
            .select("id")
            .eq("code", code)
            .single();

        if (existing) {
            return res.status(409).json({
                success: false,
                error: "کد سند تکراری است"
            });
        }

        const { data, error } = await supabaseAdmin
            .from("document_types")
            .insert({
                code: Number(code),
                name,
                description,
                is_active: is_active !== undefined ? is_active : true
            })
            .select()
            .single();

        if (error) {
            console.error("❌ Create error:", error);
            return res.status(400).json({
                success: false,
                error: error.message
            });
        }

        return res.json({
            success: true,
            data,
            message: "نوع سند با موفقیت ایجاد شد"
        });

    } catch (e) {
        console.error("❌ Server error:", e);
        return res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

/* ============================================================
   UPDATE DOCUMENT TYPE (Protected)
============================================================ */
router.put("/:id", authMiddleware, async (req, res) => {
    try {
        const id = req.params.id;
        const updates = req.body;

        // اگر code تغییر کرده، چک کن تکراری نباشه
        if (updates.code) {
            const { data: existing } = await supabaseAdmin
                .from("document_types")
                .select("id")
                .eq("code", updates.code)
                .neq("id", id)
                .single();

            if (existing) {
                return res.status(409).json({
                    success: false,
                    error: "کد سند تکراری است"
                });
            }
        }

        const { data, error } = await supabaseAdmin
            .from("document_types")
            .update(updates)
            .eq("id", id)
            .select()
            .single();

        if (error) {
            console.error("❌ Update error:", error);
            return res.status(400).json({
                success: false,
                error: error.message
            });
        }

        return res.json({
            success: true,
            data,
            message: "نوع سند با موفقیت بروزرسانی شد"
        });

    } catch (e) {
        console.error("❌ Server error:", e);
        return res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

/* ============================================================
   DELETE DOCUMENT TYPE (Protected)
============================================================ */
router.delete("/:id", authMiddleware, async (req, res) => {
    try {
        const id = req.params.id;

        const { error } = await supabaseAdmin
            .from("document_types")
            .delete()
            .eq("id", id);

        // Foreign key violation
        if (error?.code === "23503") {
            return res.status(409).json({
                success: false,
                error: "امکان حذف این نوع سند وجود ندارد",
                message: "این نوع سند در رسیدها استفاده شده است"
            });
        }

        if (error) {
            console.error("❌ Delete error:", error);
            return res.status(400).json({
                success: false,
                error: error.message
            });
        }

        return res.json({
            success: true,
            message: "نوع سند با موفقیت حذف شد"
        });

    } catch (e) {
        console.error("❌ Server error:", e);
        return res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

module.exports = router;