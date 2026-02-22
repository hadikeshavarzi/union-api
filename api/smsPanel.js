const express = require("express");
const router = express.Router();
const { pool } = require("../supabaseAdmin");
const authMiddleware = require("./middleware/auth");
const { requireSuperAdmin } = require("./middleware/auth");
const { sendSms } = require("./utils/sms");

router.use(authMiddleware);
router.use(requireSuperAdmin);

/* ─── GET /members - لیست اعضا برای انتخاب گیرنده ─── */
router.get("/members", async (req, res) => {
    try {
        const { category, status, search } = req.query;
        const values = [];
        const clauses = ["mobile IS NOT NULL", "mobile != ''"];

        if (category) { values.push(category); clauses.push(`category = $${values.length}`); }
        if (status) { values.push(status); clauses.push(`member_status = $${values.length}`); }
        if (search) {
            values.push(`%${search}%`);
            const idx = values.length;
            clauses.push(`(full_name ILIKE $${idx} OR mobile ILIKE $${idx} OR member_code ILIKE $${idx})`);
        }

        const sql = `SELECT id, full_name, mobile, category, member_status, member_code
                      FROM members WHERE ${clauses.join(" AND ")}
                      ORDER BY full_name`;
        const { rows } = await pool.query(sql, values);
        res.json({ success: true, data: rows });
    } catch (e) {
        console.error("sms-panel/members error:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

/* ─── GET /categories - لیست دسته‌بندی‌های اعضا ─── */
router.get("/categories", async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT DISTINCT category FROM members
            WHERE category IS NOT NULL AND category != ''
            ORDER BY category
        `);
        res.json({ success: true, data: rows.map(r => r.category) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/* ─── POST /send - ارسال پیامک ─── */
router.post("/send", async (req, res) => {
    try {
        const { recipients, message, sendType, categoryFilter, statusFilter } = req.body;
        if (!message || !message.trim()) return res.status(400).json({ success: false, error: "متن پیامک الزامی است" });

        let targetMembers = [];

        if (sendType === "all") {
            const { rows } = await pool.query(
                `SELECT id, full_name, mobile FROM members WHERE mobile IS NOT NULL AND mobile != ''`
            );
            targetMembers = rows;
        } else if (sendType === "category") {
            const vals = [];
            const conds = ["mobile IS NOT NULL", "mobile != ''"];
            if (categoryFilter) { vals.push(categoryFilter); conds.push(`category = $${vals.length}`); }
            if (statusFilter) { vals.push(statusFilter); conds.push(`member_status = $${vals.length}`); }
            const { rows } = await pool.query(
                `SELECT id, full_name, mobile FROM members WHERE ${conds.join(" AND ")}`, vals
            );
            targetMembers = rows;
        } else {
            if (!recipients || !recipients.length) return res.status(400).json({ success: false, error: "گیرنده‌ای انتخاب نشده" });
            const { rows } = await pool.query(
                `SELECT id, full_name, mobile FROM members WHERE id = ANY($1) AND mobile IS NOT NULL`, [recipients]
            );
            targetMembers = rows;
        }

        if (!targetMembers.length) return res.status(400).json({ success: false, error: "هیچ عضوی با شماره موبایل معتبر یافت نشد" });

        let successCount = 0;
        let failCount = 0;
        const results = [];

        for (const m of targetMembers) {
            const ok = await sendSms(m.mobile, message);
            if (ok) successCount++; else failCount++;
            results.push({ id: m.id, name: m.full_name, mobile: m.mobile, ok });
        }

        await pool.query(
            `INSERT INTO sms_logs (member_id, recipients, recipient_names, message, send_type, category_filter, status_filter, total_count, success_count, fail_count)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
                req.user.member_id || req.user.id,
                targetMembers.map(m => m.mobile),
                targetMembers.map(m => m.full_name),
                message,
                sendType || "single",
                categoryFilter || null,
                statusFilter || null,
                targetMembers.length,
                successCount,
                failCount
            ]
        );

        res.json({
            success: true,
            total: targetMembers.length,
            successCount,
            failCount,
            results
        });
    } catch (e) {
        console.error("sms-panel/send error:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

/* ─── GET /history - تاریخچه ارسال ─── */
router.get("/history", async (req, res) => {
    try {
        const limit = Math.min(Number(req.query.limit) || 50, 200);
        const offset = Number(req.query.offset) || 0;

        const { rows } = await pool.query(
            `SELECT id, recipients, recipient_names, message, send_type, category_filter, status_filter,
                    total_count, success_count, fail_count, created_at
             FROM sms_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]
        );
        const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS total FROM sms_logs`);

        res.json({ success: true, data: rows, total: countRows[0]?.total || 0 });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/* ─── GET /templates - قالب‌های پیشنهادی ─── */
router.get("/templates", async (_req, res) => {
    res.json({
        success: true,
        data: [
            { id: 1, title: "اطلاع‌رسانی عمومی", text: "مشتری گرامی\n{message}\nسامانه مدیریت انبار\nلغو11" },
            { id: 2, title: "یادآوری پرداخت", text: "جناب {name}\nیادآوری: سررسید پرداخت شما نزدیک است.\nلطفا نسبت به تسویه اقدام فرمایید.\nسامانه مدیریت انبار\nلغو11" },
            { id: 3, title: "تبریک عید", text: "جناب {name}\nسال نو مبارک!\nسامانه مدیریت انبار\nلغو11" },
            { id: 4, title: "اطلاعیه تغییر ساعت", text: "مشتری گرامی\nبه اطلاع میرساند ساعت کاری انبار از تاریخ ... تغییر خواهد کرد.\nسامانه مدیریت انبار\nلغو11" },
        ]
    });
});

module.exports = router;
