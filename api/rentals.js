const express = require('express');
const router = express.Router();
const { pool } = require('../supabaseAdmin');
const authMiddleware = require('./middleware/auth');

const nullIfEmpty = (v) => (v === '' || v === undefined || v === null) ? null : v;

// ============================================================
// GET /api/rentals - لیست قراردادها
// ============================================================
router.get('/', authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.member_id;
        const { status, customer_id } = req.query;

        let query = `
            SELECT
                wr.*,
                at.title AS customer_title,
                c.name AS customer_name,
                c.mobile AS customer_mobile
            FROM public.warehouse_rentals wr
            LEFT JOIN public.accounting_tafsili at ON wr.customer_id = at.id
            LEFT JOIN public.customers c ON c.tafsili_id = wr.customer_id
            WHERE wr.member_id = $1
        `;
        const params = [member_id];

        if (status) {
            params.push(status);
            query += ` AND wr.status = $${params.length}`;
        }
        if (customer_id) {
            params.push(customer_id);
            query += ` AND wr.customer_id = $${params.length}`;
        }

        query += ` ORDER BY wr.created_at DESC`;

        const { rows } = await pool.query(query, params);

        const result = rows.map(r => ({
            ...r,
            customer: {
                id: r.customer_id,
                title: r.customer_title || r.customer_name || 'نامشخص',
                mobile: r.customer_mobile
            }
        }));

        res.json({ success: true, data: result });
    } catch (e) {
        console.error('❌ Get Rentals Error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// GET /api/rentals/customers/list - لیست مشتریان قابل اجاره
// (MUST be before /:id to avoid route collision)
// ============================================================
router.get('/customers/list', authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.member_id;

        const { rows } = await pool.query(`
            SELECT c.id, c.name, c.mobile, c.tafsili_id
            FROM public.customers c
            WHERE c.member_id = $1 AND c.tafsili_id IS NOT NULL
            ORDER BY c.name
        `, [member_id]);

        const result = rows.map(c => ({
            id: c.tafsili_id,
            title: c.name,
            mobile: c.mobile,
            original_customer_id: c.id
        }));

        res.json({ success: true, data: result });
    } catch (e) {
        console.error('❌ Get Rental Customers Error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// GET /api/rentals/:id - جزئیات یک قرارداد
// ============================================================
router.get('/:id', authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.member_id;
        const { id } = req.params;

        const { rows } = await pool.query(`
            SELECT
                wr.*,
                at.title AS customer_title,
                c.name AS customer_name,
                c.mobile AS customer_mobile
            FROM public.warehouse_rentals wr
            LEFT JOIN public.accounting_tafsili at ON wr.customer_id = at.id
            LEFT JOIN public.customers c ON c.tafsili_id = wr.customer_id
            WHERE wr.id = $1 AND wr.member_id = $2
        `, [id, member_id]);

        if (!rows.length) {
            return res.status(404).json({ success: false, error: 'قرارداد یافت نشد' });
        }

        const r = rows[0];
        res.json({
            success: true,
            data: {
                ...r,
                customer: {
                    id: r.customer_id,
                    title: r.customer_title || r.customer_name || 'نامشخص',
                    mobile: r.customer_mobile
                }
            }
        });
    } catch (e) {
        console.error('❌ Get Rental Error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// POST /api/rentals - ثبت قرارداد جدید
// ============================================================
router.post('/', authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.member_id;
        const {
            customer_id, start_date, monthly_rent, location_name,
            rental_type, rental_details, description,
            notification_config, billing_cycle, contract_file_url,
            is_verified
        } = req.body;

        if (!customer_id || !start_date || !monthly_rent) {
            return res.status(400).json({ success: false, error: 'فیلدهای الزامی: customer_id, start_date, monthly_rent' });
        }

        const status = is_verified ? 'active' : 'draft';

        const { rows } = await pool.query(`
            INSERT INTO public.warehouse_rentals
                (member_id, customer_id, start_date, monthly_rent, location_name,
                 rental_type, rental_details, description,
                 notification_config, billing_cycle, contract_file_url,
                 status, last_invoiced_at, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULL, NOW())
            RETURNING *
        `, [
            member_id, customer_id, start_date,
            Number(monthly_rent) || 0, nullIfEmpty(location_name),
            nullIfEmpty(rental_type) || 'shed',
            rental_details ? JSON.stringify(rental_details) : null,
            nullIfEmpty(description),
            notification_config ? JSON.stringify(notification_config) : null,
            nullIfEmpty(billing_cycle) || 'monthly',
            nullIfEmpty(contract_file_url),
            status
        ]);

        res.json({ success: true, data: rows[0] });
    } catch (e) {
        console.error('❌ Create Rental Error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// PUT /api/rentals/:id - ویرایش قرارداد
// ============================================================
router.put('/:id', authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.member_id;
        const { id } = req.params;
        const updates = req.body;

        const existing = await pool.query(
            'SELECT id FROM public.warehouse_rentals WHERE id = $1 AND member_id = $2',
            [id, member_id]
        );
        if (!existing.rows.length) {
            return res.status(404).json({ success: false, error: 'قرارداد یافت نشد' });
        }

        const allowedFields = [
            'monthly_rent', 'location_name', 'status', 'description',
            'billing_cycle', 'rental_type', 'rental_details',
            'notification_config', 'start_date', 'end_date',
            'contract_file_url'
        ];

        const setClauses = [];
        const params = [id, member_id];

        for (const field of allowedFields) {
            if (updates[field] !== undefined) {
                params.push(
                    (field === 'rental_details' || field === 'notification_config')
                        ? JSON.stringify(updates[field])
                        : updates[field]
                );
                setClauses.push(`${field} = $${params.length}`);
            }
        }

        if (!setClauses.length) {
            return res.status(400).json({ success: false, error: 'هیچ فیلدی برای بروزرسانی ارسال نشده' });
        }

        await pool.query(
            `UPDATE public.warehouse_rentals SET ${setClauses.join(', ')} WHERE id = $1 AND member_id = $2`,
            params
        );

        res.json({ success: true });
    } catch (e) {
        console.error('❌ Update Rental Error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// DELETE /api/rentals/:id - حذف قرارداد
// ============================================================
router.delete('/:id', authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.member_id;
        const { id } = req.params;

        const result = await pool.query(
            'DELETE FROM public.warehouse_rentals WHERE id = $1 AND member_id = $2 RETURNING id',
            [id, member_id]
        );

        if (!result.rows.length) {
            return res.status(404).json({ success: false, error: 'قرارداد یافت نشد' });
        }

        res.json({ success: true });
    } catch (e) {
        console.error('❌ Delete Rental Error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// POST /api/rentals/:id/terminate - فسخ قرارداد + سند حسابداری
// ============================================================
router.post('/:id/terminate', authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const member_id = req.user.member_id;
        const { id } = req.params;
        const {
            end_date, should_generate_invoice, amount,
            description, debit_description, credit_description
        } = req.body;

        await client.query('BEGIN');

        const { rows: rentalRows } = await client.query(
            'SELECT * FROM public.warehouse_rentals WHERE id = $1 AND member_id = $2',
            [id, member_id]
        );
        if (!rentalRows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'قرارداد یافت نشد' });
        }

        const rental = rentalRows[0];

        if (should_generate_invoice && amount > 0) {
            const moeinReceivable = await client.query(
                "SELECT id FROM public.accounting_moein WHERE code = '1200' AND member_id = $1 LIMIT 1",
                [member_id]
            );
            const moeinIncome = await client.query(
                "SELECT id FROM public.accounting_moein WHERE code = '7100' AND member_id = $1 LIMIT 1",
                [member_id]
            );

            let receivableMoeinId = moeinReceivable.rows[0]?.id;
            let incomeMoeinId = moeinIncome.rows[0]?.id;

            if (!receivableMoeinId || !incomeMoeinId) {
                const fallbackMoein = await client.query(
                    "SELECT id FROM public.accounting_moein WHERE member_id = $1 ORDER BY id LIMIT 2",
                    [member_id]
                );
                if (fallbackMoein.rows.length >= 2) {
                    receivableMoeinId = receivableMoeinId || fallbackMoein.rows[0].id;
                    incomeMoeinId = incomeMoeinId || fallbackMoein.rows[1].id;
                } else {
                    await client.query('ROLLBACK');
                    return res.status(400).json({
                        success: false,
                        error: 'حساب‌های معین برای ثبت سند یافت نشد. لطفاً سرفصل‌های حسابداری را تنظیم کنید.'
                    });
                }
            }

            const docNo = await client.query(
                "SELECT COALESCE(MAX(doc_no), 0) + 1 AS next_no FROM public.financial_documents WHERE member_id = $1",
                [member_id]
            );
            const nextDocNo = docNo.rows[0].next_no;

            const { rows: docRows } = await client.query(`
                INSERT INTO public.financial_documents
                    (member_id, doc_no, doc_date, doc_type, description, status)
                VALUES ($1, $2, $3, 'rent_terminate', $4, 'confirmed')
                RETURNING id
            `, [
                member_id, nextDocNo, end_date,
                description || `تسویه حساب اجاره قرارداد #${id}`
            ]);

            const docId = docRows[0].id;

            await client.query(`
                INSERT INTO public.financial_entries
                    (doc_id, moein_id, tafsili_id, bed, bes, description, member_id)
                VALUES
                    ($1, $2, $3, $4, 0, $5, $8),
                    ($1, $6, NULL, 0, $4, $7, $8)
            `, [
                docId, receivableMoeinId, rental.customer_id, amount,
                debit_description || `بدهکار بابت تسویه اجاره انبار`,
                incomeMoeinId,
                credit_description || `بستانکار بابت درآمد اجاره انبار`,
                member_id
            ]);
        }

        await client.query(`
            UPDATE public.warehouse_rentals
            SET status = 'terminated', end_date = $3,
                last_invoiced_at = CASE WHEN $4 THEN $3 ELSE last_invoiced_at END
            WHERE id = $1 AND member_id = $2
        `, [id, member_id, end_date, should_generate_invoice && amount > 0]);

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('❌ Terminate Rental Error:', e);
        res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

// ============================================================
// POST /api/rentals/:id/invoice - صدور سند دوره‌ای
// ============================================================
router.post('/:id/invoice', authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const member_id = req.user.member_id;
        const { id } = req.params;
        const { period_start, period_end, amount, description } = req.body;

        if (!amount || amount <= 0) {
            return res.status(400).json({ success: false, error: 'مبلغ الزامی است' });
        }

        await client.query('BEGIN');

        const { rows: rentalRows } = await client.query(
            'SELECT * FROM public.warehouse_rentals WHERE id = $1 AND member_id = $2',
            [id, member_id]
        );
        if (!rentalRows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'قرارداد یافت نشد' });
        }

        const rental = rentalRows[0];

        const moeinReceivable = await client.query(
            "SELECT id FROM public.accounting_moein WHERE code = '1200' AND member_id = $1 LIMIT 1",
            [member_id]
        );
        const moeinIncome = await client.query(
            "SELECT id FROM public.accounting_moein WHERE code = '7100' AND member_id = $1 LIMIT 1",
            [member_id]
        );

        let receivableMoeinId = moeinReceivable.rows[0]?.id;
        let incomeMoeinId = moeinIncome.rows[0]?.id;

        if (!receivableMoeinId || !incomeMoeinId) {
            const fallback = await client.query(
                "SELECT id FROM public.accounting_moein WHERE member_id = $1 ORDER BY id LIMIT 2",
                [member_id]
            );
            receivableMoeinId = receivableMoeinId || fallback.rows[0]?.id;
            incomeMoeinId = incomeMoeinId || fallback.rows[1]?.id;
        }

        if (!receivableMoeinId || !incomeMoeinId) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: 'حساب معین یافت نشد' });
        }

        const docNo = await client.query(
            "SELECT COALESCE(MAX(doc_no), 0) + 1 AS next_no FROM public.financial_documents WHERE member_id = $1",
            [member_id]
        );

        const { rows: docRows } = await client.query(`
            INSERT INTO public.financial_documents
                (member_id, doc_no, doc_date, doc_type, description, status)
            VALUES ($1, $2, CURRENT_DATE, 'rent_invoice', $3, 'confirmed')
            RETURNING id
        `, [
            member_id, docNo.rows[0].next_no,
            description || `سند اجاره دوره ${period_start} تا ${period_end}`
        ]);

        const docId = docRows[0].id;

        await client.query(`
            INSERT INTO public.financial_entries
                (doc_id, moein_id, tafsili_id, bed, bes, description, member_id)
            VALUES
                ($1, $2, $3, $4, 0, $5, $7),
                ($1, $6, NULL, 0, $4, $5, $7)
        `, [
            docId, receivableMoeinId, rental.customer_id, amount,
            description || `اجاره انبار دوره ${period_start} تا ${period_end}`,
            incomeMoeinId, member_id
        ]);

        await client.query(
            'UPDATE public.warehouse_rentals SET last_invoiced_at = $3 WHERE id = $1 AND member_id = $2',
            [id, member_id, period_end]
        );

        await client.query('COMMIT');
        res.json({ success: true, doc_id: docId });
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('❌ Invoice Rental Error:', e);
        res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

module.exports = router;
