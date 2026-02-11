// api/media.js - MULTI-TENANT (LOCAL STORAGE VERSION, ADAPTER SAFE)
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { supabaseAdmin } = require("../supabaseAdmin");
const authMiddleware = require("./middleware/auth");

const router = express.Router();

// مسیر ذخیره‌سازی محلی
const UPLOAD_ROOT = path.join(process.cwd(), "uploads");
const MEDIA_DIR = path.join(UPLOAD_ROOT, "media");

// اطمینان از وجود پوشه‌ها
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// Multer (memory)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

/* ============================================================
   Helper: UUID -> member_id عددی
============================================================ */
async function getNumericMemberId(idInput) {
    if (!idInput) return null;
    if (!isNaN(idInput) && !String(idInput).includes("-")) return Number(idInput);

    const { data, error } = await supabaseAdmin
        .from("members")
        .select("id")
        .eq("auth_user_id", idInput)
        .maybeSingle();

    if (error) {
        console.error("❌ getNumericMemberId error:", error.message);
        return null;
    }
    return data ? Number(data.id) : null;
}

/* ============================================================
   GET ALL MEDIA (لیست فایل‌ها) - بدون range (سازگار با adapter)
============================================================ */
router.get("/", authMiddleware, async (req, res) => {
    try {
        const { limit = 50, offset = 0, related_table, related_id } = req.query;

        let member_id = await getNumericMemberId(req.user?.id);
        if (!member_id) member_id = 2;

        let query = supabaseAdmin
            .from("media")
            .select("*", { count: "exact" })
            .eq("member_id", member_id)
            .order("created_at", { ascending: false })
            .limit(Number(limit) + Number(offset)); // چون offset نداریم، بعداً slice می‌کنیم

        if (related_table) query = query.eq("related_table", related_table);
        if (related_id) query = query.eq("related_id", Number(related_id));

        const { data, error, count } = await query;
        if (error) throw error;

        const rows = Array.isArray(data) ? data : [];
        const sliced = rows.slice(Number(offset), Number(offset) + Number(limit));

        return res.json({
            success: true,
            data: sliced,
            total: Number(count ?? rows.length),
            limit: Number(limit),
            offset: Number(offset),
        });
    } catch (e) {
        console.error("❌ GET Media Error:", e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   UPLOAD MEDIA (ذخیره محلی روی سرور)
   مسیر دسترسی: /uploads/media/<member_id>/<filename>
============================================================ */
router.post("/upload", authMiddleware, upload.single("file"), async (req, res) => {
    try {
        const file = req.file;
        const { related_table, related_id, description } = req.body || {};

        let member_id = await getNumericMemberId(req.user?.id);
        if (!member_id) member_id = 2;

        if (!file) {
            return res.status(400).json({ success: false, error: "فایل دریافت نشد" });
        }

        // پوشه‌ی اختصاصی هر ممبر
        const memberDir = path.join(MEDIA_DIR, String(member_id));
        fs.mkdirSync(memberDir, { recursive: true });

        // نام فایل امن
        const safeOriginal = String(file.originalname || "file")
            .replace(/[^\w.\-()]+/g, "_")
            .slice(0, 180);

        const uniqueName = `${Date.now()}-${Math.random().toString(16).slice(2)}-${safeOriginal}`;
        const absPath = path.join(memberDir, uniqueName);

        // ذخیره روی دیسک
        fs.writeFileSync(absPath, file.buffer);

        // مسیر نسبی برای DB
        const relPath = path.join("uploads", "media", String(member_id), uniqueName).replace(/\\/g, "/");

        // URL عمومی (با فرض اینکه app.use("/uploads", express.static("uploads")) دارید)
        const publicUrl = `/${relPath}`; // اگر پشت nginx هستید: https://api.domain.com/uploads/...

        // ثبت متادیتا در DB
        const { data: mediaRecord, error: dbError } = await supabaseAdmin
            .from("media")
            .insert({
                filepath: relPath,
                filename: file.originalname,
                mimetype: file.mimetype,
                size: Number(file.size),
                related_table: related_table || null,
                related_id: related_id ? Number(related_id) : null,
                description: description || null,
                member_id: member_id,
            })
            .select()
            .single();

        if (dbError) {
            // پاک کردن فایل اگر DB fail شد
            try { fs.unlinkSync(absPath); } catch {}
            throw dbError;
        }

        return res.json({
            success: true,
            url: publicUrl,
            file: mediaRecord,
        });
    } catch (err) {
        console.error("❌ Upload Error:", err?.message || err);
        return res.status(500).json({ success: false, error: err.message || "خطای داخلی سرور" });
    }
});

/* ============================================================
   DELETE MEDIA (حذف فایل + رکورد DB) - multi-tenant safe
============================================================ */
router.delete("/:id", authMiddleware, async (req, res) => {
    try {
        const id = Number(req.params.id);

        let member_id = await getNumericMemberId(req.user?.id);
        if (!member_id) member_id = 2;

        // پیدا کردن رکورد (با tenant check)
        const { data: media, error: findError } = await supabaseAdmin
            .from("media")
            .select("*")
            .eq("id", id)
            .eq("member_id", member_id)
            .single();

        if (findError || !media) {
            return res.status(404).json({ success: false, error: "فایل یافت نشد یا دسترسی ندارید" });
        }

        // حذف فایل از دیسک (اگر هست)
        const absPath = path.join(process.cwd(), String(media.filepath || ""));
        try {
            if (absPath.includes(path.join("uploads", "media", String(member_id)))) {
                if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
            }
        } catch (e) {
            console.error("❌ Local file delete error:", e.message);
            // حتی اگر فایل حذف نشد، رکورد DB را پاک می‌کنیم
        }

        // حذف رکورد از DB
        const { error: dbError } = await supabaseAdmin
            .from("media")
            .delete()
            .eq("id", id)
            .eq("member_id", member_id);

        if (dbError) throw dbError;

        return res.json({ success: true, message: "حذف شد" });
    } catch (err) {
        console.error("❌ Delete Error:", err?.message || err);
        return res.status(500).json({ success: false, error: err.message || "حذف فایل شکست خورد" });
    }
});

module.exports = router;
