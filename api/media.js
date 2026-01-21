// api/media.js - MULTI-TENANT
const express = require("express");
const multer = require("multer");
const { supabaseAdmin } = require("../supabaseAdmin");
const authMiddleware = require("./middleware/auth");

const router = express.Router();

// Multer for file upload (memory)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB
    }
});

/* ============================================================
   GET ALL MEDIA (لیست فایل‌ها)
============================================================ */
router.get("/", authMiddleware, async (req, res) => {
    try {
        const { limit = 50, offset = 0, related_table, related_id } = req.query;
        const member_id = req.user.id;

        let query = supabaseAdmin
            .from("media")
            .select("*", { count: "exact" })
            .eq("member_id", member_id) // ✅ فیلتر تنانت
            .order("created_at", { ascending: false });

        if (related_table) query = query.eq("related_table", related_table);
        if (related_id) query = query.eq("related_id", related_id);

        query = query.range(Number(offset), Number(offset) + Number(limit) - 1);

        const { data, error, count } = await query;

        if (error) {
            console.error("❌ GET Media Error:", error);
            return res.status(400).json({ success: false, error: error.message });
        }

        return res.json({ success: true, data, total: count });
    } catch (e) {
        console.error("❌ Server Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   UPLOAD MEDIA
============================================================ */
router.post("/upload", authMiddleware, upload.single("file"), async (req, res) => {
    try {
        const file = req.file;
        const member_id = req.user.id;
        const { related_table, related_id, description } = req.body;

        if (!file) {
            return res.status(400).json({ success: false, error: "فایل دریافت نشد" });
        }

        // ✅ نام فایل با member_id برای جدا کردن فایل‌ها
        const fileName = `${member_id}/${Date.now()}-${file.originalname}`;

        // Upload to Supabase Storage bucket: "media"
        const { data: uploadData, error: uploadError } = await supabaseAdmin
            .storage
            .from("media")
            .upload(fileName, file.buffer, {
                contentType: file.mimetype,
                upsert: false,
            });

        if (uploadError) {
            console.error("❌ Storage Upload Error:", uploadError);
            return res.status(500).json({ success: false, error: "آپلود فایل شکست خورد" });
        }

        // Public URL for the file
        const { data: publicURLData } = supabaseAdmin
            .storage
            .from("media")
            .getPublicUrl(fileName);

        // Insert metadata into PostgreSQL media table
        const { data: mediaRecord, error: dbError } = await supabaseAdmin
            .from("media")
            .insert({
                filepath: fileName,
                filename: file.originalname,
                mimetype: file.mimetype,
                size: file.size,
                related_table: related_table || null,
                related_id: related_id ? Number(related_id) : null,
                description: description || null,
                member_id // ✅ تزریق خودکار
            })
            .select()
            .single();

        if (dbError) {
            console.error("❌ DB Insert Error:", dbError);
            return res.status(500).json({ success: false, error: "ذخیره اطلاعات فایل شکست خورد" });
        }

        return res.json({
            success: true,
            url: publicURLData.publicUrl,
            file: mediaRecord,
        });

    } catch (err) {
        console.error("❌ Upload Error:", err);
        return res.status(500).json({ success: false, error: "خطای داخلی سرور" });
    }
});

/* ============================================================
   DELETE MEDIA
============================================================ */
router.delete("/:id", authMiddleware, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const member_id = req.user.id;

        // ✅ Find media record (با چک member_id)
        const { data: media, error: findError } = await supabaseAdmin
            .from("media")
            .select("*")
            .eq("id", id)
            .eq("member_id", member_id) // ✅ فیلتر تنانت
            .single();

        if (findError || !media) {
            return res.status(404).json({ success: false, error: "فایل یافت نشد یا دسترسی ندارید" });
        }

        // Remove from storage
        const { error: storageError } = await supabaseAdmin.storage
            .from("media")
            .remove([media.filepath]);

        if (storageError) {
            console.error("❌ Storage Delete Error:", storageError);
        }

        // Remove from DB
        const { error: dbError } = await supabaseAdmin
            .from("media")
            .delete()
            .eq("id", id)
            .eq("member_id", member_id);

        if (dbError) {
            console.error("❌ DB Delete Error:", dbError);
            return res.status(400).json({ success: false, error: dbError.message });
        }

        return res.json({ success: true });

    } catch (err) {
        console.error("❌ Delete Error:", err);
        return res.status(500).json({ success: false, error: "حذف فایل شکست خورد" });
    }
});

module.exports = router;