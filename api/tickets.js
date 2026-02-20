const express = require("express");
const router = express.Router();
const { pool } = require("../supabaseAdmin");
const authMiddleware = require("./middleware/auth");

const isUUID = (s) => s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const toInt = (v, fb) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : fb; };

const ADMIN_ROLES = new Set(["admin", "owner", "super_admin", "superadmin", "manager", "root", "system_admin"]);

async function getTenantMemberIds(userId) {
    const { rows: subMembers } = await pool.query(
        `SELECT id FROM members WHERE owner_id = $1`, [userId]
    );
    const ids = [userId, ...subMembers.map(m => m.id)];
    return ids;
}

/* ===================== CATEGORIES ===================== */

router.get("/categories", authMiddleware, async (req, res) => {
    try {
        const memberId = req.user.member_id || req.user.id;
        const isAdmin = ADMIN_ROLES.has((req.user.role || "").toLowerCase());

        let rows;
        if (isAdmin) {
            const tenantIds = await getTenantMemberIds(memberId);
            const result = await pool.query(
                `SELECT * FROM public.ticket_categories WHERE member_id = ANY($1::uuid[]) AND is_active = true ORDER BY sort_order ASC, name ASC`,
                [tenantIds]
            );
            rows = result.rows;
        } else {
            const result = await pool.query(
                `SELECT * FROM public.ticket_categories WHERE member_id = $1 AND is_active = true ORDER BY sort_order ASC, name ASC`,
                [memberId]
            );
            rows = result.rows;
        }
        res.json({ success: true, data: rows });
    } catch (e) {
        console.error("GET Ticket Categories Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post("/categories", authMiddleware, async (req, res) => {
    try {
        const memberId = req.user.member_id || req.user.id;
        const { name, icon, color, sort_order } = req.body;
        if (!name) return res.status(400).json({ success: false, error: "نام دسته الزامی است" });

        const { rows } = await pool.query(
            `INSERT INTO public.ticket_categories (member_id, name, icon, color, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
            [memberId, name, icon || "bx-help-circle", color || "#556ee6", sort_order || 0]
        );
        res.json({ success: true, data: rows[0] });
    } catch (e) {
        console.error("POST Ticket Category Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/* ===================== TICKETS LIST ===================== */

router.get("/", authMiddleware, async (req, res) => {
    try {
        const memberId = req.user.member_id || req.user.id;
        const userId = req.user.id;
        const role = (req.user.role || "").toLowerCase();
        const isAdmin = ADMIN_ROLES.has(role);
        const limit = Math.min(toInt(req.query.limit, 50), 500);
        const offset = toInt(req.query.offset, 0);

        const values = [];
        const where = [];

        if (isAdmin) {
            const tenantIds = await getTenantMemberIds(memberId);
            values.push(tenantIds);
            where.push(`t.member_id = ANY($${values.length}::uuid[])`);
        } else {
            values.push(memberId);
            where.push(`t.member_id = $${values.length}`);
            values.push(userId);
            where.push(`t.created_by = $${values.length}`);
        }

        if (req.query.status) {
            values.push(req.query.status);
            where.push(`t.status = $${values.length}`);
        }
        if (req.query.priority) {
            values.push(req.query.priority);
            where.push(`t.priority = $${values.length}`);
        }
        if (req.query.category_id && isUUID(req.query.category_id)) {
            values.push(req.query.category_id);
            where.push(`t.category_id = $${values.length}`);
        }
        const search = (req.query.search || "").trim();
        if (search) {
            values.push(`%${search}%`);
            const idx = values.length;
            where.push(`(t.subject ILIKE $${idx} OR CAST(t.ticket_no AS text) ILIKE $${idx} OR COALESCE(t.created_by_name,'') ILIKE $${idx})`);
        }

        const whereSql = where.join(" AND ");

        const listSql = `
            SELECT t.*, cat.name AS category_name, cat.icon AS category_icon, cat.color AS category_color,
                (SELECT COUNT(*)::int FROM public.ticket_messages tm WHERE tm.ticket_id = t.id) AS message_count,
                (SELECT tm.created_at FROM public.ticket_messages tm WHERE tm.ticket_id = t.id ORDER BY tm.created_at DESC LIMIT 1) AS last_message_at
            FROM public.tickets t
            LEFT JOIN public.ticket_categories cat ON cat.id = t.category_id
            WHERE ${whereSql}
            ORDER BY
                CASE t.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'waiting' THEN 2 WHEN 'resolved' THEN 3 WHEN 'closed' THEN 4 END,
                CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
                t.updated_at DESC
            LIMIT $${values.length + 1} OFFSET $${values.length + 2}`;

        const countSql = `SELECT COUNT(*)::int AS total FROM public.tickets t WHERE ${whereSql}`;

        const [listRes, countRes] = await Promise.all([
            pool.query(listSql, [...values, limit, offset]),
            pool.query(countSql, values)
        ]);

        res.json({
            success: true,
            data: {
                items: listRes.rows,
                total: countRes.rows[0]?.total || 0,
                limit, offset
            }
        });
    } catch (e) {
        console.error("GET Tickets Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/* ===================== TICKET STATS ===================== */

router.get("/stats", authMiddleware, async (req, res) => {
    try {
        const memberId = req.user.member_id || req.user.id;
        const userId = req.user.id;
        const role = (req.user.role || "").toLowerCase();
        const isAdmin = ADMIN_ROLES.has(role);

        let whereSql, values;
        if (isAdmin) {
            const tenantIds = await getTenantMemberIds(memberId);
            values = [tenantIds];
            whereSql = `member_id = ANY($1::uuid[])`;
        } else {
            values = [memberId, userId];
            whereSql = `member_id = $1 AND created_by = $2`;
        }

        const { rows } = await pool.query(`
            SELECT
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'open')::int AS open_count,
                COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress_count,
                COUNT(*) FILTER (WHERE status = 'waiting')::int AS waiting_count,
                COUNT(*) FILTER (WHERE status = 'resolved')::int AS resolved_count,
                COUNT(*) FILTER (WHERE status = 'closed')::int AS closed_count,
                COUNT(*) FILTER (WHERE priority = 'urgent' AND status NOT IN ('closed','resolved'))::int AS urgent_count,
                ROUND(AVG(rating) FILTER (WHERE rating IS NOT NULL), 1)::float AS avg_rating
            FROM public.tickets
            WHERE ${whereSql}
        `, values);

        res.json({ success: true, data: rows[0] });
    } catch (e) {
        console.error("GET Ticket Stats Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/* ===================== SINGLE TICKET ===================== */

router.get("/:id", authMiddleware, async (req, res) => {
    try {
        const memberId = req.user.member_id || req.user.id;
        const role = (req.user.role || "").toLowerCase();
        const isAdmin = ADMIN_ROLES.has(role);
        const { id } = req.params;
        if (!isUUID(id)) return res.status(400).json({ success: false, error: "شناسه نامعتبر" });

        let rows;
        if (isAdmin) {
            const tenantIds = await getTenantMemberIds(memberId);
            const result = await pool.query(`
                SELECT t.*, cat.name AS category_name, cat.icon AS category_icon, cat.color AS category_color
                FROM public.tickets t
                LEFT JOIN public.ticket_categories cat ON cat.id = t.category_id
                WHERE t.id = $1 AND t.member_id = ANY($2::uuid[])
            `, [id, tenantIds]);
            rows = result.rows;
        } else {
            const result = await pool.query(`
                SELECT t.*, cat.name AS category_name, cat.icon AS category_icon, cat.color AS category_color
                FROM public.tickets t
                LEFT JOIN public.ticket_categories cat ON cat.id = t.category_id
                WHERE t.id = $1 AND t.member_id = $2
            `, [id, memberId]);
            rows = result.rows;
        }

        if (!rows.length) return res.status(404).json({ success: false, error: "تیکت یافت نشد" });

        const msgs = await pool.query(
            `SELECT * FROM public.ticket_messages WHERE ticket_id = $1 ORDER BY created_at ASC`,
            [id]
        );

        res.json({ success: true, data: { ...rows[0], messages: msgs.rows } });
    } catch (e) {
        console.error("GET Ticket Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/* ===================== CREATE TICKET ===================== */

router.post("/", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const memberId = req.user.member_id || req.user.id;
        const userId = req.user.id;
        const userName = req.user.full_name || "کاربر";
        const { subject, description, category_id, priority, tags } = req.body;

        if (!subject || !subject.trim()) return res.status(400).json({ success: false, error: "موضوع تیکت الزامی است" });

        await client.query("BEGIN");

        const { rows } = await client.query(`
            INSERT INTO public.tickets (member_id, category_id, subject, description, priority, created_by, created_by_name, tags)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *
        `, [
            memberId,
            category_id && isUUID(category_id) ? category_id : null,
            subject.trim(),
            description || null,
            ["low", "medium", "high", "urgent"].includes(priority) ? priority : "medium",
            userId,
            userName,
            tags && Array.isArray(tags) ? tags : null
        ]);

        const ticket = rows[0];

        if (description && description.trim()) {
            await client.query(`
                INSERT INTO public.ticket_messages (ticket_id, sender_id, sender_name, sender_role, message)
                VALUES ($1, $2, $3, $4, $5)
            `, [ticket.id, userId, userName, "user", description.trim()]);
        }

        await client.query("COMMIT");
        res.status(201).json({ success: true, data: ticket });
    } catch (e) {
        await client.query("ROLLBACK");
        console.error("POST Ticket Error:", e);
        res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

/* ===================== UPDATE TICKET ===================== */

router.put("/:id", authMiddleware, async (req, res) => {
    try {
        const memberId = req.user.member_id || req.user.id;
        const role = (req.user.role || "").toLowerCase();
        const isAdmin = ADMIN_ROLES.has(role);
        const { id } = req.params;
        if (!isUUID(id)) return res.status(400).json({ success: false, error: "شناسه نامعتبر" });

        let existing;
        if (isAdmin) {
            const tenantIds = await getTenantMemberIds(memberId);
            existing = await pool.query("SELECT * FROM public.tickets WHERE id = $1 AND member_id = ANY($2::uuid[])", [id, tenantIds]);
        } else {
            existing = await pool.query("SELECT * FROM public.tickets WHERE id = $1 AND member_id = $2", [id, memberId]);
        }
        if (!existing.rows.length) return res.status(404).json({ success: false, error: "تیکت یافت نشد" });

        const b = req.body;
        const sets = [];
        const vals = [id];

        if (b.status) { vals.push(b.status); sets.push(`status = $${vals.length}`); }
        if (b.priority) { vals.push(b.priority); sets.push(`priority = $${vals.length}`); }
        if (b.subject) { vals.push(b.subject); sets.push(`subject = $${vals.length}`); }
        if (b.assigned_to !== undefined) {
            vals.push(b.assigned_to || null);
            sets.push(`assigned_to = $${vals.length}`);
            vals.push(b.assigned_to_name || null);
            sets.push(`assigned_to_name = $${vals.length}`);
        }
        if (b.category_id !== undefined) {
            vals.push(b.category_id && isUUID(b.category_id) ? b.category_id : null);
            sets.push(`category_id = $${vals.length}`);
        }

        if (b.status === "closed" || b.status === "resolved") {
            vals.push(new Date().toISOString());
            sets.push(`closed_at = $${vals.length}`);
            vals.push(req.user.id);
            sets.push(`closed_by = $${vals.length}`);
        }

        if (b.rating) {
            vals.push(Math.min(5, Math.max(1, parseInt(b.rating))));
            sets.push(`rating = $${vals.length}`);
            if (b.rating_comment) {
                vals.push(b.rating_comment);
                sets.push(`rating_comment = $${vals.length}`);
            }
        }

        sets.push("updated_at = NOW()");

        if (sets.length <= 1) return res.status(400).json({ success: false, error: "هیچ تغییری ارسال نشده" });

        const { rows } = await pool.query(
            `UPDATE public.tickets SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
            vals
        );

        res.json({ success: true, data: rows[0] });
    } catch (e) {
        console.error("PUT Ticket Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/* ===================== DELETE TICKET ===================== */

router.delete("/:id", authMiddleware, async (req, res) => {
    try {
        const memberId = req.user.member_id || req.user.id;
        const role = (req.user.role || "").toLowerCase();
        const isAdmin = ADMIN_ROLES.has(role);
        const { id } = req.params;
        if (!isUUID(id)) return res.status(400).json({ success: false, error: "شناسه نامعتبر" });

        let result;
        if (isAdmin) {
            const tenantIds = await getTenantMemberIds(memberId);
            result = await pool.query("DELETE FROM public.tickets WHERE id = $1 AND member_id = ANY($2::uuid[]) RETURNING id", [id, tenantIds]);
        } else {
            result = await pool.query("DELETE FROM public.tickets WHERE id = $1 AND member_id = $2 RETURNING id", [id, memberId]);
        }
        if (!result.rows.length) return res.status(404).json({ success: false, error: "تیکت یافت نشد" });

        res.json({ success: true, message: "تیکت حذف شد" });
    } catch (e) {
        console.error("DELETE Ticket Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/* ===================== TICKET MESSAGES ===================== */

router.post("/:id/messages", authMiddleware, async (req, res) => {
    try {
        const memberId = req.user.member_id || req.user.id;
        const role = (req.user.role || "").toLowerCase();
        const isAdmin = ADMIN_ROLES.has(role);
        const { id } = req.params;
        if (!isUUID(id)) return res.status(400).json({ success: false, error: "شناسه نامعتبر" });

        let ticket;
        if (isAdmin) {
            const tenantIds = await getTenantMemberIds(memberId);
            ticket = await pool.query("SELECT id, status FROM public.tickets WHERE id = $1 AND member_id = ANY($2::uuid[])", [id, tenantIds]);
        } else {
            ticket = await pool.query("SELECT id, status FROM public.tickets WHERE id = $1 AND member_id = $2", [id, memberId]);
        }
        if (!ticket.rows.length) return res.status(404).json({ success: false, error: "تیکت یافت نشد" });

        const { message, is_internal, attachments } = req.body;
        if (!message || !message.trim()) return res.status(400).json({ success: false, error: "متن پیام الزامی است" });

        const userId = req.user.id;
        const userName = req.user.full_name || "کاربر";
        const userRole = isAdmin ? "admin" : "user";

        const { rows } = await pool.query(`
            INSERT INTO public.ticket_messages (ticket_id, sender_id, sender_name, sender_role, message, is_internal, attachments)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
        `, [id, userId, userName, userRole, message.trim(), is_internal || false, JSON.stringify(attachments || [])]);

        if (ticket.rows[0].status === "resolved" || ticket.rows[0].status === "closed") {
            await pool.query("UPDATE public.tickets SET status = 'open', updated_at = NOW() WHERE id = $1", [id]);
        } else {
            const newStatus = isAdmin ? "waiting" : "in_progress";
            await pool.query("UPDATE public.tickets SET status = $1, updated_at = NOW() WHERE id = $2", [newStatus, id]);
        }

        res.status(201).json({ success: true, data: rows[0] });
    } catch (e) {
        console.error("POST Ticket Message Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
