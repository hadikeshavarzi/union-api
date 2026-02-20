const express = require('express');
const router = express.Router();
const { pool } = require('../supabaseAdmin');
const authMiddleware = require('./middleware/auth');

const nullIfEmpty = (v) => (v === '' || v === undefined || v === null) ? null : v;

// ============================================================
// GET /api/calendar/events?month=2026-02&date=2026-02-19
// رویدادهای تقویم (ترکیب دستی + خودکار)
// ============================================================
router.get('/events', authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.member_id;
        const { month, date_from, date_to, date, type, category } = req.query;

        let startDate, endDate;

        if (date) {
            startDate = date;
            endDate = date;
        } else if (date_from && date_to) {
            startDate = date_from;
            endDate = date_to;
        } else if (month) {
            startDate = `${month}-01`;
            const d = new Date(startDate);
            d.setMonth(d.getMonth() + 1);
            d.setDate(0);
            endDate = d.toISOString().slice(0, 10);
        } else {
            const now = new Date();
            startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
            const d = new Date(startDate);
            d.setMonth(d.getMonth() + 1);
            d.setDate(0);
            endDate = d.toISOString().slice(0, 10);
        }

        const allEvents = [];

        // 1. Manual events from calendar_events table
        let manualQuery = `
            SELECT * FROM public.calendar_events
            WHERE member_id = $1 AND event_date >= $2 AND event_date <= $3
        `;
        const manualParams = [member_id, startDate, endDate];
        if (type && type !== 'all') {
            manualParams.push(type);
            manualQuery += ` AND event_type = $${manualParams.length}`;
        }
        if (category && category !== 'all') {
            manualParams.push(category);
            manualQuery += ` AND category = $${manualParams.length}`;
        }
        manualQuery += ` ORDER BY event_date, event_time`;

        const { rows: manualRows } = await pool.query(manualQuery, manualParams);
        manualRows.forEach(e => {
            allEvents.push({
                id: e.id,
                date: e.event_date,
                time: e.event_time,
                title: e.title,
                description: e.description,
                type: e.event_type,
                category: e.category,
                color: e.color,
                ref_id: e.ref_id,
                ref_table: e.ref_table,
                is_manual: true,
                status: e.status,
                is_reminder: e.is_reminder,
                reminder_date: e.reminder_date,
                reminder_method: e.reminder_method
            });
        });

        // 2. Receipts (رسید ورود)
        if (!type || type === 'all' || type === 'receipt') {
            const { rows: receipts } = await pool.query(`
                SELECT r.id, r.receipt_no, r.doc_date, c.name AS owner_name,
                    COUNT(ri.id)::int AS items_count
                FROM public.receipts r
                LEFT JOIN public.customers c ON c.id = r.owner_id
                LEFT JOIN public.receipt_items ri ON ri.receipt_id = r.id
                WHERE r.member_id = $1 AND r.doc_date >= $2 AND r.doc_date <= $3
                GROUP BY r.id, r.receipt_no, r.doc_date, c.name
                ORDER BY r.doc_date
            `, [member_id, startDate, endDate]);

            receipts.forEach(r => {
                allEvents.push({
                    id: `receipt-${r.id}`,
                    date: r.doc_date,
                    title: `رسید #${r.receipt_no}${r.owner_name ? ` - ${r.owner_name}` : ''}`,
                    description: `${r.items_count} قلم کالا`,
                    type: 'receipt',
                    category: 'warehouse',
                    color: '#34c38f',
                    ref_id: r.id,
                    ref_table: 'receipts',
                    is_manual: false
                });
            });
        }

        // 3. Exits (خروجی)
        if (!type || type === 'all' || type === 'exit') {
            const { rows: exits } = await pool.query(`
                SELECT e.id, e.exit_no, e.exit_date, c.name AS owner_name
                FROM public.warehouse_exits e
                LEFT JOIN public.customers c ON c.id = e.owner_id
                WHERE e.member_id = $1 AND e.exit_date >= $2 AND e.exit_date <= $3
                ORDER BY e.exit_date
            `, [member_id, startDate, endDate]);

            exits.forEach(e => {
                allEvents.push({
                    id: `exit-${e.id}`,
                    date: e.exit_date,
                    title: `خروجی #${e.exit_no}${e.owner_name ? ` - ${e.owner_name}` : ''}`,
                    type: 'exit',
                    category: 'warehouse',
                    color: '#f46a6a',
                    ref_id: e.id,
                    ref_table: 'warehouse_exits',
                    is_manual: false
                });
            });
        }

        // 4. Clearances (ترخیص)
        if (!type || type === 'all' || type === 'clearance') {
            const { rows: clears } = await pool.query(`
                SELECT cl.id, cl.clearance_no, cl.clearance_date, c.name AS owner_name
                FROM public.clearances cl
                LEFT JOIN public.customers c ON c.id = cl.customer_id
                WHERE cl.member_id = $1 AND cl.clearance_date >= $2 AND cl.clearance_date <= $3
                ORDER BY cl.clearance_date
            `, [member_id, startDate, endDate]);

            clears.forEach(cl => {
                allEvents.push({
                    id: `clearance-${cl.id}`,
                    date: cl.clearance_date,
                    title: `ترخیص #${cl.clearance_no}${cl.owner_name ? ` - ${cl.owner_name}` : ''}`,
                    type: 'clearance',
                    category: 'warehouse',
                    color: '#50a5f1',
                    ref_id: cl.id,
                    ref_table: 'clearances',
                    is_manual: false
                });
            });
        }

        // 5. Loadings (بارگیری)
        if (!type || type === 'all' || type === 'loading') {
            const { rows: loads } = await pool.query(`
                SELECT l.id, l.order_no, l.loading_date, l.driver_name
                FROM public.loading_orders l
                WHERE l.member_id = $1 AND l.loading_date >= $2 AND l.loading_date <= $3
                ORDER BY l.loading_date
            `, [member_id, startDate, endDate]);

            loads.forEach(l => {
                allEvents.push({
                    id: `loading-${l.id}`,
                    date: l.loading_date,
                    title: `بارگیری #${l.order_no}${l.driver_name ? ` - ${l.driver_name}` : ''}`,
                    type: 'loading',
                    category: 'warehouse',
                    color: '#f1b44c',
                    ref_id: l.id,
                    ref_table: 'loading_orders',
                    is_manual: false
                });
            });
        }

        // 6. Cheque due dates - receivable (سررسید چک دریافتنی)
        if (!type || type === 'all' || type === 'cheque_recv') {
            const { rows: recvCheques } = await pool.query(`
                SELECT ch.id, ch.cheque_no, ch.amount, ch.due_date,
                    ch.status, at.title AS person_name
                FROM public.treasury_checks ch
                LEFT JOIN public.accounting_tafsili at ON ch.owner_id = at.id
                WHERE ch.member_id = $1 AND ch.due_date >= $2 AND ch.due_date <= $3
                    AND ch.type = 'receivable'
                    AND ch.status NOT IN ('cashed', 'returned', 'cancelled')
                ORDER BY ch.due_date
            `, [member_id, startDate, endDate]);

            recvCheques.forEach(ch => {
                allEvents.push({
                    id: `cheque-recv-${ch.id}`,
                    date: ch.due_date,
                    title: `سررسید چک دریافتنی #${ch.cheque_no || ''}`,
                    description: `${Number(ch.amount).toLocaleString()} ریال${ch.person_name ? ` - ${ch.person_name}` : ''}`,
                    type: 'cheque_recv',
                    category: 'financial',
                    color: '#34c38f',
                    ref_id: ch.id,
                    ref_table: 'treasury_checks',
                    is_manual: false
                });
            });
        }

        // 6b. Cheque due dates - payable (سررسید چک پرداختنی)
        if (!type || type === 'all' || type === 'cheque_pay') {
            const { rows: payCheques } = await pool.query(`
                SELECT ch.id, ch.cheque_no, ch.amount, ch.due_date,
                    ch.status, at.title AS person_name
                FROM public.treasury_checks ch
                LEFT JOIN public.accounting_tafsili at ON ch.owner_id = at.id
                WHERE ch.member_id = $1 AND ch.due_date >= $2 AND ch.due_date <= $3
                    AND ch.type = 'payable'
                    AND ch.status NOT IN ('cashed', 'returned', 'cancelled')
                ORDER BY ch.due_date
            `, [member_id, startDate, endDate]);

            payCheques.forEach(ch => {
                allEvents.push({
                    id: `cheque-pay-${ch.id}`,
                    date: ch.due_date,
                    title: `سررسید چک پرداختنی #${ch.cheque_no || ''}`,
                    description: `${Number(ch.amount).toLocaleString()} ریال${ch.person_name ? ` - ${ch.person_name}` : ''}`,
                    type: 'cheque_pay',
                    category: 'financial',
                    color: '#f46a6a',
                    ref_id: ch.id,
                    ref_table: 'treasury_checks',
                    is_manual: false
                });
            });
        }

        // 7. Rental due dates (سررسید اجاره)
        if (!type || type === 'all' || type === 'rent') {
            const { rows: rentals } = await pool.query(`
                SELECT wr.id, wr.customer_id, wr.monthly_rent, wr.start_date,
                    wr.billing_cycle, wr.location_name, wr.last_invoiced_at,
                    at.title AS customer_name
                FROM public.warehouse_rentals wr
                LEFT JOIN public.accounting_tafsili at ON wr.customer_id = at.id
                WHERE wr.member_id = $1 AND wr.status = 'active'
            `, [member_id]);

            const billingMonths = { monthly: 1, quarterly: 3, '6month': 6, yearly: 12 };

            rentals.forEach(r => {
                const base = r.last_invoiced_at || r.start_date;
                const months = billingMonths[r.billing_cycle] || 1;
                const nextDue = new Date(base);
                nextDue.setMonth(nextDue.getMonth() + months);
                const dueStr = nextDue.toISOString().slice(0, 10);

                if (dueStr >= startDate && dueStr <= endDate) {
                    allEvents.push({
                        id: `rent-${r.id}`,
                        date: dueStr,
                        title: `سررسید اجاره - ${r.customer_name || 'نامشخص'}`,
                        description: `${Number(r.monthly_rent).toLocaleString()} ریال - ${r.location_name || ''}`,
                        type: 'rent',
                        category: 'financial',
                        color: '#556ee6',
                        ref_id: r.id,
                        ref_table: 'warehouse_rentals',
                        is_manual: false
                    });
                }
            });
        }

        // 8. Financial documents (اسناد حسابداری)
        if (!type || type === 'all' || type === 'accounting') {
            const docTypeLabels = {
                treasury: 'دریافت/پرداخت', cheque_pass: 'وصول چک', cheque_deposit: 'واگذاری چک',
                cheque_spend: 'خرج چک', cheque_return: 'عودت چک', cheque_bounce: 'برگشت چک',
                cheque_cancel: 'ابطال چک', transfer: 'انتقال', auto: 'خروج کالا',
                auto_receipt: 'رسید کالا', system: 'سیستمی', manual: 'دستی',
                rent_terminate: 'تسویه اجاره', rent_invoice: 'سند اجاره'
            };

            const { rows: docs } = await pool.query(`
                SELECT id, doc_no, doc_date, doc_type, description
                FROM public.financial_documents
                WHERE member_id = $1 AND doc_date >= $2 AND doc_date <= $3
                ORDER BY doc_date
            `, [member_id, startDate, endDate]);

            docs.forEach(d => {
                const typeLabel = docTypeLabels[d.doc_type] || 'سند';
                allEvents.push({
                    id: `doc-${d.id}`,
                    date: d.doc_date,
                    title: `سند #${d.doc_no} - ${typeLabel}`,
                    description: d.description,
                    type: 'accounting',
                    category: 'financial',
                    color: '#74788d',
                    ref_id: d.id,
                    ref_table: 'financial_documents',
                    is_manual: false
                });
            });
        }

        allEvents.sort((a, b) => {
            const da = new Date(a.date);
            const db = new Date(b.date);
            return da - db;
        });

        // Group by date for calendar view
        const grouped = {};
        allEvents.forEach(e => {
            const dateKey = typeof e.date === 'string' ? e.date.slice(0, 10) : new Date(e.date).toISOString().slice(0, 10);
            if (!grouped[dateKey]) grouped[dateKey] = [];
            grouped[dateKey].push(e);
        });

        res.json({
            success: true,
            data: allEvents,
            grouped,
            period: { start: startDate, end: endDate },
            total: allEvents.length
        });
    } catch (e) {
        console.error('❌ Calendar Events Error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// POST /api/calendar/events - ثبت رویداد دستی
// ============================================================
router.post('/events', authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.member_id;
        const {
            title, description, event_date, event_time,
            event_type, category, color,
            is_reminder, reminder_date, reminder_time, reminder_method
        } = req.body;

        if (!title || !event_date) {
            return res.status(400).json({ success: false, error: 'عنوان و تاریخ الزامی است' });
        }

        const { rows } = await pool.query(`
            INSERT INTO public.calendar_events
                (member_id, title, description, event_date, event_time,
                 event_type, category, color,
                 is_reminder, reminder_date, reminder_time, reminder_method,
                 created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            RETURNING *
        `, [
            member_id, title, nullIfEmpty(description),
            event_date, nullIfEmpty(event_time),
            event_type || 'manual', category || 'general',
            color || '#556ee6',
            is_reminder || false,
            nullIfEmpty(reminder_date), nullIfEmpty(reminder_time),
            reminder_method || 'native',
            req.user.id
        ]);

        res.json({ success: true, data: rows[0] });
    } catch (e) {
        console.error('❌ Create Event Error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// PUT /api/calendar/events/:id - ویرایش رویداد
// ============================================================
router.put('/events/:id', authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.member_id;
        const { id } = req.params;
        const {
            title, description, event_date, event_time,
            category, color, status,
            is_reminder, reminder_date, reminder_time, reminder_method
        } = req.body;

        const { rows } = await pool.query(`
            UPDATE public.calendar_events SET
                title = COALESCE($3, title),
                description = COALESCE($4, description),
                event_date = COALESCE($5, event_date),
                event_time = $6,
                category = COALESCE($7, category),
                color = COALESCE($8, color),
                status = COALESCE($9, status),
                is_reminder = COALESCE($10, is_reminder),
                reminder_date = $11,
                reminder_time = $12,
                reminder_method = COALESCE($13, reminder_method),
                updated_at = NOW()
            WHERE id = $1 AND member_id = $2
            RETURNING *
        `, [
            id, member_id, title, description, event_date,
            nullIfEmpty(event_time), category, color, status,
            is_reminder, nullIfEmpty(reminder_date), nullIfEmpty(reminder_time),
            reminder_method
        ]);

        if (!rows.length) {
            return res.status(404).json({ success: false, error: 'رویداد یافت نشد' });
        }

        res.json({ success: true, data: rows[0] });
    } catch (e) {
        console.error('❌ Update Event Error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// DELETE /api/calendar/events/:id - حذف رویداد
// ============================================================
router.delete('/events/:id', authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.member_id;
        const { id } = req.params;

        const result = await pool.query(
            'DELETE FROM public.calendar_events WHERE id = $1 AND member_id = $2 RETURNING id',
            [id, member_id]
        );

        if (!result.rows.length) {
            return res.status(404).json({ success: false, error: 'رویداد یافت نشد' });
        }

        res.json({ success: true });
    } catch (e) {
        console.error('❌ Delete Event Error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// GET /api/calendar/reminders - یادآورهای امروز
// ============================================================
router.get('/reminders', authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.member_id;
        const today = new Date().toISOString().slice(0, 10);

        const { rows } = await pool.query(`
            SELECT * FROM public.calendar_events
            WHERE member_id = $1 AND is_reminder = true AND reminder_sent = false
                AND reminder_date <= $2 AND status = 'active'
            ORDER BY reminder_date, reminder_time
        `, [member_id, today]);

        // cheque reminders
        const { rows: chequeReminders } = await pool.query(`
            SELECT ch.id, ch.cheque_no, ch.amount, ch.due_date, ch.type,
                at.title AS person_name
            FROM public.treasury_checks ch
            LEFT JOIN public.accounting_tafsili at ON ch.owner_id = at.id
            WHERE ch.member_id = $1
                AND ch.due_date <= ($2::date + interval '3 days')
                AND ch.due_date >= $2
                AND ch.status NOT IN ('cashed', 'returned', 'cancelled')
            ORDER BY ch.due_date
        `, [member_id, today]);

        // rental reminders
        const { rows: rentalReminders } = await pool.query(`
            SELECT wr.id, wr.customer_id, wr.monthly_rent, wr.start_date,
                wr.billing_cycle, wr.location_name, wr.last_invoiced_at,
                at.title AS customer_name
            FROM public.warehouse_rentals wr
            LEFT JOIN public.accounting_tafsili at ON wr.customer_id = at.id
            WHERE wr.member_id = $1 AND wr.status = 'active'
        `, [member_id]);

        const billingMonths = { monthly: 1, quarterly: 3, '6month': 6, yearly: 12 };
        const rentalAlerts = [];
        rentalReminders.forEach(r => {
            const base = r.last_invoiced_at || r.start_date;
            const months = billingMonths[r.billing_cycle] || 1;
            const nextDue = new Date(base);
            nextDue.setMonth(nextDue.getMonth() + months);
            const dueStr = nextDue.toISOString().slice(0, 10);

            const daysUntil = Math.ceil((new Date(dueStr) - new Date(today)) / (1000 * 60 * 60 * 24));
            if (daysUntil <= 3 && daysUntil >= 0) {
                rentalAlerts.push({
                    id: r.id,
                    type: 'rent',
                    customer_name: r.customer_name,
                    location: r.location_name,
                    amount: r.monthly_rent,
                    due_date: dueStr,
                    days_until: daysUntil
                });
            }
        });

        res.json({
            success: true,
            data: {
                manual: rows,
                cheques: chequeReminders.map(ch => ({
                    id: ch.id,
                    type: ch.type === 'receivable' ? 'cheque_recv' : 'cheque_pay',
                    cheque_type: ch.type,
                    cheque_type_label: ch.type === 'receivable' ? 'دریافتنی' : 'پرداختنی',
                    cheque_no: ch.cheque_no,
                    amount: ch.amount,
                    due_date: ch.due_date,
                    person_name: ch.person_name,
                    days_until: Math.ceil((new Date(ch.due_date) - new Date(today)) / (1000 * 60 * 60 * 24))
                })),
                rentals: rentalAlerts
            }
        });
    } catch (e) {
        console.error('❌ Reminders Error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// POST /api/calendar/events/:id/mark-reminded
// ============================================================
router.post('/events/:id/mark-reminded', authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.member_id;
        await pool.query(
            'UPDATE public.calendar_events SET reminder_sent = true WHERE id = $1 AND member_id = $2',
            [req.params.id, member_id]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
