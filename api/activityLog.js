const express = require('express');
const router = express.Router();
const { pool } = require('../supabaseAdmin');
const authMiddleware = require('./middleware/auth');

const logActivity = async (req, action, entityType, entityId, description, metadata = {}) => {
    try {
        const member_id = req.user?.member_id;
        if (!member_id) return;
        const userName = req.user?.full_name || 'کاربر';
        const ip = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '';
        const ua = req.headers['user-agent'] || '';

        await pool.query(`
            INSERT INTO public.activity_logs (member_id, user_name, action, entity_type, entity_id, description, ip_address, user_agent, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [member_id, userName, action, entityType || null, entityId ? String(entityId) : null, description || null, ip, ua, JSON.stringify(metadata)]);
    } catch (e) {
        // silent fail for logging
    }
};

router.get('/', authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.member_id;
        const { limit = 50, offset = 0, action, entity_type, date_from, date_to, search } = req.query;

        const conditions = ['member_id = $1'];
        const params = [member_id];
        let idx = 2;

        if (action) { conditions.push(`action = $${idx++}`); params.push(action); }
        if (entity_type) { conditions.push(`entity_type = $${idx++}`); params.push(entity_type); }
        if (date_from) { conditions.push(`created_at >= $${idx++}::date`); params.push(date_from); }
        if (date_to) { conditions.push(`created_at <= ($${idx++}::date + interval '1 day')`); params.push(date_to); }
        if (search) { conditions.push(`(description ILIKE $${idx} OR user_name ILIKE $${idx})`); params.push(`%${search}%`); idx++; }

        const where = conditions.join(' AND ');

        const countRes = await pool.query(`SELECT COUNT(*)::int AS cnt FROM public.activity_logs WHERE ${where}`, params);
        const total = countRes.rows[0].cnt;

        params.push(Number(limit), Number(offset));
        const dataRes = await pool.query(`
            SELECT * FROM public.activity_logs WHERE ${where}
            ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}
        `, params);

        const actionsRes = await pool.query(`
            SELECT DISTINCT action FROM public.activity_logs WHERE member_id = $1 ORDER BY action
        `, [member_id]);

        const entityRes = await pool.query(`
            SELECT DISTINCT entity_type FROM public.activity_logs WHERE member_id = $1 AND entity_type IS NOT NULL ORDER BY entity_type
        `, [member_id]);

        res.json({
            success: true,
            data: dataRes.rows,
            total,
            actions: actionsRes.rows.map(r => r.action),
            entity_types: entityRes.rows.map(r => r.entity_type),
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/stats', authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.member_id;
        const today = new Date().toISOString().slice(0, 10);

        const [todayRes, weekRes, topRes] = await Promise.all([
            pool.query(`SELECT COUNT(*)::int AS cnt FROM public.activity_logs WHERE member_id = $1 AND created_at::date = $2`, [member_id, today]),
            pool.query(`SELECT COUNT(*)::int AS cnt FROM public.activity_logs WHERE member_id = $1 AND created_at >= NOW() - interval '7 days'`, [member_id]),
            pool.query(`SELECT action, COUNT(*)::int AS cnt FROM public.activity_logs WHERE member_id = $1 GROUP BY action ORDER BY cnt DESC LIMIT 5`, [member_id]),
        ]);

        res.json({
            success: true,
            data: {
                today: todayRes.rows[0].cnt,
                week: weekRes.rows[0].cnt,
                top_actions: topRes.rows,
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
module.exports.logActivity = logActivity;
