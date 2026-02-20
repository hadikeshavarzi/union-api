const express = require('express');
const router = express.Router();
const { pool } = require('../supabaseAdmin');
const authMiddleware = require('./middleware/auth');

// ============================================================
// GET /api/settings - دریافت تنظیمات انبار
// ============================================================
router.get('/', authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.member_id;

        const { rows } = await pool.query(
            'SELECT * FROM public.warehouse_settings WHERE member_id = $1',
            [member_id]
        );

        if (!rows.length) {
            return res.json({ success: true, data: null });
        }

        res.json({ success: true, data: rows[0] });
    } catch (e) {
        console.error('❌ Get Settings Error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// POST /api/settings - ذخیره/بروزرسانی تنظیمات
// ============================================================
router.post('/', authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.member_id;
        const {
            warehouse_name, warehouse_name_en, phone, fax, mobile, email, website,
            address, postal_code, economic_code, national_id, registration_no,
            logo_url, stamp_url, header_text, footer_text,
            province, city, manager_name, manager_phone, description, form_settings
        } = req.body;

        const existing = await pool.query(
            'SELECT id FROM public.warehouse_settings WHERE member_id = $1',
            [member_id]
        );

        if (existing.rows.length) {
            const { rows } = await pool.query(`
                UPDATE public.warehouse_settings SET
                    warehouse_name = COALESCE($2, warehouse_name), warehouse_name_en = COALESCE($3, warehouse_name_en),
                    phone = COALESCE($4, phone), fax = COALESCE($5, fax), mobile = COALESCE($6, mobile),
                    email = COALESCE($7, email), website = COALESCE($8, website),
                    address = COALESCE($9, address), postal_code = COALESCE($10, postal_code),
                    economic_code = COALESCE($11, economic_code),
                    national_id = COALESCE($12, national_id), registration_no = COALESCE($13, registration_no),
                    logo_url = COALESCE($14, logo_url), stamp_url = COALESCE($15, stamp_url),
                    header_text = COALESCE($16, header_text), footer_text = COALESCE($17, footer_text),
                    province = COALESCE($18, province), city = COALESCE($19, city),
                    manager_name = COALESCE($20, manager_name), manager_phone = COALESCE($21, manager_phone),
                    description = COALESCE($22, description),
                    form_settings = COALESCE($23::jsonb, form_settings),
                    updated_at = NOW()
                WHERE member_id = $1
                RETURNING *
            `, [
                member_id, warehouse_name, warehouse_name_en,
                phone, fax, mobile, email, website,
                address, postal_code, economic_code,
                national_id, registration_no,
                logo_url, stamp_url,
                header_text, footer_text,
                province, city, manager_name, manager_phone, description,
                form_settings ? JSON.stringify(form_settings) : null
            ]);
            res.json({ success: true, data: rows[0] });
        } else {
            const { rows } = await pool.query(`
                INSERT INTO public.warehouse_settings
                    (member_id, warehouse_name, warehouse_name_en,
                     phone, fax, mobile, email, website,
                     address, postal_code, economic_code,
                     national_id, registration_no,
                     logo_url, stamp_url,
                     header_text, footer_text,
                     province, city, manager_name, manager_phone, description, form_settings)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb)
                RETURNING *
            `, [
                member_id, warehouse_name, warehouse_name_en,
                phone, fax, mobile, email, website,
                address, postal_code, economic_code,
                national_id, registration_no,
                logo_url, stamp_url,
                header_text, footer_text,
                province, city, manager_name, manager_phone, description,
                form_settings ? JSON.stringify(form_settings) : null
            ]);
            res.json({ success: true, data: rows[0] });
        }
    } catch (e) {
        console.error('Save Settings Error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
