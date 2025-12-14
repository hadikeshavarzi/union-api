const express = require("express");
const multer = require("multer");
const { supabaseAdmin } = require("../supabaseAdmin");
const router = express.Router();

// Multer for file upload (memory)
const upload = multer({ storage: multer.memoryStorage() });

// =============================
// UPLOAD MEDIA
// POST /api/media/upload
// =============================
router.post("/upload", upload.single("file"), async (req, res) => {
    try {
        const file = req.file;

        if (!file) {
            return res.status(400).json({ error: "فایل دریافت نشد" });
        }

        const fileName = `${Date.now()}-${file.originalname}`;

        // Upload to Supabase Storage bucket: "media"
        const { data: uploadData, error: uploadError } = await supabaseAdmin
            .storage
            .from("media")
            .upload(fileName, file.buffer, {
                contentType: file.mimetype,
                upsert: false,
            });

        if (uploadError) {
            console.error(uploadError);
            return res.status(500).json({ error: "آپلود فایل شکست خورد" });
        }

        // Public URL for the file
        const { data: publicURL } = supabaseAdmin
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
            })
            .select()
            .single();

        if (dbError) {
            console.error(dbError);
            return res.status(500).json({ error: "ذخیره اطلاعات فایل در DB شکست خورد" });
        }

        return res.json({
            success: true,
            url: publicURL.publicUrl,
            file: mediaRecord,
        });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "خطای داخلی سرور" });
    }
});

// =============================
// DELETE MEDIA
// DELETE /api/media/:id
// =============================
router.delete("/:id", async (req, res) => {
    try {
        const id = req.params.id;

        // Find media record
        const { data: media, error: findError } = await supabaseAdmin
            .from("media")
            .select("*")
            .eq("id", id)
            .single();

        if (findError || !media) {
            return res.status(404).json({ error: "فایل یافت نشد" });
        }

        // Remove from storage
        await supabaseAdmin.storage
            .from("media")
            .remove([media.filepath]);

        // Remove from DB
        await supabaseAdmin
            .from("media")
            .delete()
            .eq("id", id);

        return res.json({ success: true });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "حذف فایل شکست خورد" });
    }
});

module.exports = router;
