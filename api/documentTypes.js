// api/documentTypes.js
const express = require("express");
const { supabaseAdmin } = require("../supabaseAdmin");
const authMiddleware = require("./middleware/auth");

const router = express.Router();

/* ============================================================
   Utils
============================================================ */
function toBool(v) {
    if (v === true || v === false) return v;
    if (typeof v === "string") return v.toLowerCase() === "true";
    return null;
}

function toNumber(v, fallback = NaN) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function normalizePayload(body) {
    const payload = {};

    if (body.code !== undefined) payload.code = toNumber(body.code, NaN);
    if (body.name !== undefined) payload.name = String(body.name || "").trim();
    if (body.description !== undefined) payload.description = body.description ?? null;
    if (body.is_active !== undefined) payload.is_active = toBool(body.is_active);

    // حذف فیلدهای نامعتبر
    if (payload.code !== undefined && !Number.isFinite(payload.code)) delete payload.code;
    if (payload.name !== undefined && !payload.name) delete payload.name;
    if (payload.is_active === null) delete payload.is_active;

    return payload;
}

/* ============================================================
   GET ALL (Public)
============================================================ */
router.get("/", async (req, res) => {
    try {
        const isActive = toBool(req.query.is_active);

        let query = supabaseAdmin
            .from("document_types")
            .select("*")
            .order("code", { ascending: true });

        if (isActive === true) query = query.eq("is_active", true);
        if (isActive === false) query = query.eq("is_active", false);

        const { data, error } = await query;

        if (error) {
            console.error("❌ Error fetching document types:", error.message);
            return res.status(400).json({ success: false, error: error.message });
        }

        return res.json({ success: true, data: data || [] });
    } catch (e) {
        console.error("❌ Server error:", e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   GET ONE (Public)
============================================================ */
router.get("/:id", async (req, res) => {
    try {
        const id = req.params.id;

        const { data, error } = await supabaseAdmin
            .from("document_types")
            .select("*")
            .eq("id", id)
            .maybeSingle();

        if (error) {
            return res.status(400).json({ success: false, error: error.message });
        }

        if (!data) {
            return res.status(404).json({ success: false, error: "نوع سند یافت نشد" });
        }

        return res.json({ success: true, data });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   CREATE (Protected)
============================================================ */
router.post("/", authMiddleware, async (req, res) => {
    try {
        const payload = normalizePayload(req.body);

        if (payload.code === undefined || payload.name === undefined) {
            return res.status(400).json({
                success: false,
                error: "code و name الزامی هستند",
            });
        }

        // چک تکراری بودن code
        const { data: existing, error: existErr } = await supabaseAdmin
            .from("document_types")
            .select("id")
            .eq("code", payload.code)
            .maybeSingle();

        if (existErr) {
            return res.status(400).json({ success: false, error: existErr.message });
        }

        if (existing) {
            return res.status(409).json({ success: false, error: "کد سند تکراری است" });
        }

        // مقدار پیش‌فرض is_active
        if (payload.is_active === undefined) payload.is_active = true;

        const { data, error } = await supabaseAdmin
            .from("document_types")
            .insert(payload)
            .select()
            .single();

        if (error) {
            console.error("❌ Create error:", error.message);
            return res.status(400).json({ success: false, error: error.message });
        }

        return res.json({
            success: true,
            data,
            message: "نوع سند با موفقیت ایجاد شد",
        });
    } catch (e) {
        console.error("❌ Server error:", e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   UPDATE (Protected)
============================================================ */
router.put("/:id", authMiddleware, async (req, res) => {
    try {
        const id = req.params.id;
        const updates = normalizePayload(req.body);

        if (!Object.keys(updates).length) {
            return res.status(400).json({ success: false, error: "هیچ فیلدی برای بروزرسانی ارسال نشده" });
        }

        // اگر code تغییر کرده، تکراری نباشد
        if (updates.code !== undefined) {
            const { data: sameCodeRows, error: codeErr } = await supabaseAdmin
                .from("document_types")
                .select("id")
                .eq("code", updates.code);

            if (codeErr) {
                return res.status(400).json({ success: false, error: codeErr.message });
            }

            // چون adapter neq ندارد، دستی چک می‌کنیم
            const conflict = (sameCodeRows || []).some((r) => String(r.id) !== String(id));
            if (conflict) {
                return res.status(409).json({ success: false, error: "کد سند تکراری است" });
            }
        }

        const { data, error } = await supabaseAdmin
            .from("document_types")
            .update(updates)
            .eq("id", id)
            .select()
            .maybeSingle();

        if (error) {
            console.error("❌ Update error:", error.message);
            return res.status(400).json({ success: false, error: error.message });
        }

        if (!data) {
            return res.status(404).json({ success: false, error: "نوع سند یافت نشد" });
        }

        return res.json({
            success: true,
            data,
            message: "نوع سند با موفقیت بروزرسانی شد",
        });
    } catch (e) {
        console.error("❌ Server error:", e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   DELETE (Protected)
============================================================ */
router.delete("/:id", authMiddleware, async (req, res) => {
    try {
        const id = req.params.id;

        const { data, error } = await supabaseAdmin
            .from("document_types")
            .delete()
            .eq("id", id);

        if (error?.code === "23503") {
            return res.status(409).json({
                success: false,
                error: "امکان حذف این نوع سند وجود ندارد",
                message: "این نوع سند در اسناد/رسیدها استفاده شده است",
            });
        }

        if (error) {
            console.error("❌ Delete error:", error.message);
            return res.status(400).json({ success: false, error: error.message });
        }

        // اگر چیزی حذف نشد
        if (!data || data.length === 0) {
            return res.status(404).json({ success: false, error: "نوع سند یافت نشد" });
        }

        return res.json({ success: true, message: "نوع سند با موفقیت حذف شد" });
    } catch (e) {
        console.error("❌ Server error:", e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
