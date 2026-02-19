// api/media.js - MULTI-TENANT (LOCAL STORAGE VERSION, pool-based)
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { pool } = require("../supabaseAdmin");
const authMiddleware = require("./middleware/auth");

const router = express.Router();

const UPLOAD_ROOT = path.join(process.cwd(), "uploads");
const MEDIA_DIR = path.join(UPLOAD_ROOT, "media");

fs.mkdirSync(MEDIA_DIR, { recursive: true });

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
});

/* ============================================================
   GET ALL MEDIA
============================================================ */
router.get("/", authMiddleware, async (req, res) => {
    try {
        const { limit = 50, offset = 0, related_table, related_id } = req.query;
        const member_id = req.user.member_id;

        const conditions = ["member_id = $1"];
        const params = [member_id];
        let idx = 2;

        if (related_table) {
            conditions.push(`related_table = $${idx++}`);
            params.push(related_table);
        }
        if (related_id) {
            conditions.push(`related_id = $${idx++}`);
            params.push(Number(related_id));
        }

        const where = conditions.join(" AND ");

        const countRes = await pool.query(`SELECT COUNT(*)::int AS cnt FROM public.media WHERE ${where}`, params);
        const total = countRes.rows[0].cnt;

        params.push(Number(limit), Number(offset));
        const dataRes = await pool.query(
            `SELECT * FROM public.media WHERE ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
            params
        );

        return res.json({
            success: true,
            data: dataRes.rows,
            total,
            limit: Number(limit),
            offset: Number(offset),
        });
    } catch (e) {
        console.error("❌ GET Media Error:", e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* ============================================================
   UPLOAD MEDIA
============================================================ */
router.post("/upload", authMiddleware, upload.single("file"), async (req, res) => {
    try {
        const file = req.file;
        const { related_table, related_id, description } = req.body || {};
        const member_id = req.user.member_id;

        if (!file) {
            return res.status(400).json({ success: false, error: "فایل دریافت نشد" });
        }

        const memberDir = path.join(MEDIA_DIR, String(member_id));
        fs.mkdirSync(memberDir, { recursive: true });

        const safeOriginal = String(file.originalname || "file")
            .replace(/[^\w.\-()]+/g, "_")
            .slice(0, 180);

        const uniqueName = `${Date.now()}-${Math.random().toString(16).slice(2)}-${safeOriginal}`;
        const absPath = path.join(memberDir, uniqueName);

        fs.writeFileSync(absPath, file.buffer);

        const relPath = path.join("uploads", "media", String(member_id), uniqueName).replace(/\\/g, "/");
        const publicUrl = `/${relPath}`;

        const insertRes = await pool.query(
            `INSERT INTO public.media (filepath, filename, mimetype, size, related_table, related_id, description, member_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [
                relPath,
                file.originalname,
                file.mimetype,
                Number(file.size),
                related_table || null,
                related_id ? Number(related_id) : null,
                description || null,
                member_id,
            ]
        );

        return res.json({
            success: true,
            url: publicUrl,
            file: insertRes.rows[0],
        });
    } catch (err) {
        console.error("❌ Upload Error:", err?.message || err);
        return res.status(500).json({ success: false, error: err.message || "خطای داخلی سرور" });
    }
});

/* ============================================================
   DELETE MEDIA
============================================================ */
router.delete("/:id", authMiddleware, async (req, res) => {
    try {
        const id = req.params.id;
        const member_id = req.user.member_id;

        const findRes = await pool.query(
            "SELECT * FROM public.media WHERE id = $1 AND member_id = $2",
            [id, member_id]
        );

        if (findRes.rows.length === 0) {
            return res.status(404).json({ success: false, error: "فایل یافت نشد یا دسترسی ندارید" });
        }

        const media = findRes.rows[0];

        const absPath = path.join(process.cwd(), String(media.filepath || ""));
        try {
            if (absPath.includes(path.join("uploads", "media", String(member_id)))) {
                if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
            }
        } catch (e) {
            console.error("❌ Local file delete error:", e.message);
        }

        await pool.query("DELETE FROM public.media WHERE id = $1 AND member_id = $2", [id, member_id]);

        return res.json({ success: true, message: "حذف شد" });
    } catch (err) {
        console.error("❌ Delete Error:", err?.message || err);
        return res.status(500).json({ success: false, error: err.message || "حذف فایل شکست خورد" });
    }
});

module.exports = router;
