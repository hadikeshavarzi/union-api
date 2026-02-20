// union-api/api/reports/index.js
const express = require("express");
const router = express.Router();
const { pool } = require("../../supabaseAdmin");
const authMiddleware = require("../middleware/auth");

// ============================================================
// 1. گزارش مانده حساب اشخاص (مشتریان/تامین‌کنندگان)
// مسیر: /api/reports/balances?type=customer
// ============================================================
router.get("/balances", authMiddleware, async (req, res) => {
    try {
        const { type } = req.query;
        const member_id = req.user.member_id;

        // ✅ اصلاح شده: اتصال به جدول customers برای گرفتن موبایل
        let query = `
            SELECT 
                t.id, t.code, t.title, t.tafsili_type, 
                c.mobile, -- دریافت موبایل از جدول مشتریان
                COALESCE(SUM(e.bed), 0) as "totalBed",
                COALESCE(SUM(e.bes), 0) as "totalBes",
                (COALESCE(SUM(e.bed), 0) - COALESCE(SUM(e.bes), 0)) as balance
            FROM public.accounting_tafsili t
            LEFT JOIN public.financial_entries e ON t.id = e.tafsili_id
            LEFT JOIN public.customers c ON t.id = c.tafsili_id -- اتصال برای اطلاعات تکمیلی مثل موبایل
            WHERE t.member_id = $1 AND t.is_active = true
        `;

        const params = [member_id];

        if (type) {
            params.push(type);
            query += ` AND t.tafsili_type = $${params.length}`;
        }

        // در GROUP BY حتما باید c.mobile هم باشد
        query += ` GROUP BY t.id, t.code, t.title, t.tafsili_type, c.mobile ORDER BY t.code ASC`;

        const { rows } = await pool.query(query, params);

        // افزودن وضعیت متنی (بدهکار/بستانکار)
        const report = rows.map(row => ({
            ...row,
            totalBed: Number(row.totalBed),
            totalBes: Number(row.totalBes),
            balance: Number(row.balance),
            status: Number(row.balance) > 0 ? 'بدهکار' : Number(row.balance) < 0 ? 'بستانکار' : 'تسویه'
        }));

        res.json({ success: true, data: report });
    } catch (e) {
        console.error("❌ Balance Report Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// 2. گزارش موجودی نقد و بانک (خزانه‌داری)
// مسیر: /api/reports/treasury-balances?type=bank
// ============================================================
router.get("/treasury-balances", authMiddleware, async (req, res) => {
    try {
        const { type } = req.query;
        const member_id = req.user.member_id;

        if (type === 'bank') {
            // 1. دریافت بانک‌ها
            const { rows: banks } = await pool.query(
                `SELECT id, bank_name, account_no, tafsili_id FROM public.treasury_banks WHERE member_id = $1`,
                [member_id]
            );

            // 2. دریافت پوزها (برای محاسبه موجودی متصل به بانک)
            const { rows: posDevices } = await pool.query(
                `SELECT p.id, p.title, p.terminal_id, p.tafsili_id, p.bank_id, b.bank_name 
                 FROM public.treasury_pos p
                 LEFT JOIN public.treasury_banks b ON p.bank_id = b.id
                 WHERE p.member_id = $1`,
                [member_id]
            );

            // 3. جمع‌آوری شناسه تفصیلی‌ها برای محاسبه مانده
            const allTafsiliIds = [
                ...banks.map(b => b.tafsili_id),
                ...posDevices.map(p => p.tafsili_id)
            ].filter(id => id); 

            if (allTafsiliIds.length === 0) {
                return res.json({ success: true, data: { banks: [], posDevices: [], summary: {} } });
            }

            // 4. محاسبه مانده‌ها با یک کوئری سریع از جدول سندها
            const { rows: balances } = await pool.query(`
                SELECT tafsili_id, SUM(bed) as bed, SUM(bes) as bes
                FROM public.financial_entries
                WHERE tafsili_id = ANY($1)
                GROUP BY tafsili_id
            `, [allTafsiliIds]);

            const balMap = {};
            balances.forEach(b => {
                balMap[b.tafsili_id] = { bed: Number(b.bed), bes: Number(b.bes) };
            });

            // 5. ترکیب داده‌ها (موجودی بانک + موجودی پوزهای متصل)
            const bankReport = banks.map(bank => {
                const bBal = balMap[bank.tafsili_id] || { bed: 0, bes: 0 };

                // پیدا کردن پوزهای متصل به این بانک
                const myPos = posDevices.filter(p => p.bank_id === bank.id);
                let posBed = 0, posBes = 0;

                myPos.forEach(p => {
                    const pBal = balMap[p.tafsili_id] || { bed: 0, bes: 0 };
                    posBed += pBal.bed;
                    posBes += pBal.bes;
                });

                const bankOnlyBalance = bBal.bed - bBal.bes;
                const posOnlyBalance = posBed - posBes;

                return {
                    ...bank,
                    bankBalance: bankOnlyBalance, // مانده خود حساب بانکی
                    posBalance: posOnlyBalance,   // مانده وجوه در پوز (تصفیه نشده)
                    balance: bankOnlyBalance + posOnlyBalance, // موجودی کل قابل دسترس
                    posCount: myPos.length
                };
            });

            // محاسبه خلاصه کل
            const summary = {
                totalBankBalance: bankReport.reduce((sum, b) => sum + b.balance, 0)
            };

            res.json({ success: true, data: { banks: bankReport, posDevices: [], summary } });

        } else if (type === 'cash') {
            // گزارش صندوق‌ها
            const { rows: cashes } = await pool.query(`
                SELECT c.id, c.title, c.tafsili_id, 
                       COALESCE(SUM(e.bed), 0) as "totalBed",
                       COALESCE(SUM(e.bes), 0) as "totalBes"
                FROM public.treasury_cashes c
                LEFT JOIN public.financial_entries e ON c.tafsili_id = e.tafsili_id
                WHERE c.member_id = $1
                GROUP BY c.id, c.title, c.tafsili_id
            `, [member_id]);

            const report = cashes.map(c => ({
                ...c,
                balance: Number(c.totalBed) - Number(c.totalBes)
            }));

            res.json({ success: true, data: report });
        }
    } catch (e) {
        console.error("❌ Treasury Report Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// 3. تراز آزمایشی (Trial Balance)
// مسیر: /api/reports/trial-balance
// ============================================================
router.get("/trial-balance", authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.member_id;

        // محاسبه سطح معین (کد، نام، جمع بدهکار، جمع بستانکار، مانده)
        const query = `
            SELECT 
                m.id, m.code, m.title,
                COALESCE(SUM(e.bed), 0) as "totalBed",
                COALESCE(SUM(e.bes), 0) as "totalBes",
                (COALESCE(SUM(e.bed), 0) - COALESCE(SUM(e.bes), 0)) as balance
            FROM public.accounting_moein m
            LEFT JOIN public.financial_entries e ON m.id = e.moein_id
            LEFT JOIN public.financial_documents d ON e.doc_id = d.id
            WHERE m.member_id = $1 AND (d.id IS NULL OR d.status = 'confirmed' OR d.status = 'final')
            GROUP BY m.id, m.code, m.title
            ORDER BY m.code ASC
        `;

        const { rows } = await pool.query(query, [member_id]);

        // حذف ردیف‌هایی که گردش صفر دارند (اختیاری)
        const filtered = rows.filter(r => Number(r.totalBed) !== 0 || Number(r.totalBes) !== 0);

        res.json({ success: true, data: filtered });

    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// 4. دفتر تفصیلی و ریز گردش (Ledger Detail)
// مسیر: /api/reports/ledger/:tafsiliId
// ============================================================
router.get("/ledger/:tafsiliId", authMiddleware, async (req, res) => {
    try {
        const { tafsiliId } = req.params;
        const { startDate, endDate } = req.query;
        const member_id = req.user.member_id;

        // 1. بررسی نوع تفصیلی (اگر بانک است، پوزها را هم پیدا کن تا گردش تجمیعی نشان دهیم)
        const { rows: bankCheck } = await pool.query(
            `SELECT id FROM public.treasury_banks WHERE tafsili_id = $1 AND member_id = $2`,
            [tafsiliId, member_id]
        );

        let targetIds = [tafsiliId];

        if (bankCheck.length > 0) {
            const bankId = bankCheck[0].id;
            const { rows: posList } = await pool.query(
                `SELECT tafsili_id FROM public.treasury_pos WHERE bank_id = $1`, [bankId]
            );
            posList.forEach(p => targetIds.push(p.tafsili_id));
        }

        // 2. کوئری دریافت گردش حساب
        let query = `
            SELECT 
                e.id, e.bed, e.bes, e.description, e.created_at, e.tafsili_id,
                d.id as doc_id, d.doc_date, d.manual_no, d.description as doc_desc,
                t.title as tafsili_title
            FROM public.financial_entries e
            JOIN public.financial_documents d ON e.doc_id = d.id
            JOIN public.accounting_tafsili t ON e.tafsili_id = t.id
            WHERE e.tafsili_id = ANY($1) AND d.member_id = $2
        `;

        const params = [targetIds, member_id];

        if (startDate) {
            params.push(startDate);
            query += ` AND d.doc_date >= $${params.length}`;
        }
        if (endDate) {
            params.push(endDate);
            query += ` AND d.doc_date <= $${params.length}`;
        }

        query += ` ORDER BY d.doc_date ASC, e.id ASC`;

        const { rows } = await pool.query(query, params);

        // 3. محاسبه مانده در لحظه (Running Balance)
        let runningBalance = 0;
        const result = rows.map(row => {
            runningBalance += (Number(row.bed) - Number(row.bes));
            return {
                ...row,
                bed: Number(row.bed),
                bes: Number(row.bes),
                runningBalance
            };
        });

        res.json({ success: true, data: result });

    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// 5. گزارش مرور حساب‌ها (جامع)
// مسیر: /api/reports/ledger
// ============================================================
router.get("/ledger", authMiddleware, async (req, res) => {
    try {
        const { moeinId, tafsiliId, startDate, endDate } = req.query;
        const member_id = req.user.member_id;

        let query = `
            SELECT 
                e.id, e.description, e.bed, e.bes, e.tafsili_id, e.moein_id,
                d.id as doc_id, d.doc_date, d.manual_no,
                m.title as moein_title, m.code as moein_code,
                t.title as tafsili_title, t.code as tafsili_code
            FROM public.financial_entries e
            JOIN public.financial_documents d ON e.doc_id = d.id
            LEFT JOIN public.accounting_moein m ON e.moein_id = m.id
            LEFT JOIN public.accounting_tafsili t ON e.tafsili_id = t.id
            WHERE d.member_id = $1
        `;

        const params = [member_id];

        if (moeinId) {
            params.push(moeinId);
            query += ` AND e.moein_id = $${params.length}`;
        }
        if (tafsiliId) {
            params.push(tafsiliId);
            query += ` AND e.tafsili_id = $${params.length}`;
        }
        if (startDate) {
            params.push(startDate);
            query += ` AND d.doc_date >= $${params.length}`;
        }
        if (endDate) {
            params.push(endDate);
            query += ` AND d.doc_date <= $${params.length}`;
        }

        query += ` ORDER BY d.doc_date ASC, d.id ASC`;

        const { rows } = await pool.query(query, params);
        res.json({ success: true, data: rows });

    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// 6. گزارش دفتر روزنامه (Journal)
// مسیر: /api/reports/journal
// ============================================================
router.get("/journal", authMiddleware, async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const member_id = req.user.member_id;

        // استفاده از JSON_AGG برای برگرداندن سند به همراه ردیف‌هایش در یک کوئری
        let query = `
            SELECT 
                d.id, d.doc_no, d.doc_date, d.manual_no, d.description, d.status,
                json_agg(json_build_object(
                    'id', e.id,
                    'bed', e.bed,
                    'bes', e.bes,
                    'description', e.description,
                    'moein_title', m.title,
                    'moein_code', m.code,
                    'tafsili_title', t.title,
                    'tafsili_code', t.code
                )) as items
            FROM public.financial_documents d
            LEFT JOIN public.financial_entries e ON d.id = e.doc_id
            LEFT JOIN public.accounting_moein m ON e.moein_id = m.id
            LEFT JOIN public.accounting_tafsili t ON e.tafsili_id = t.id
            WHERE d.member_id = $1
        `;

        const params = [member_id];

        if (startDate) {
            params.push(startDate);
            query += ` AND d.doc_date::date >= $${params.length}::date`;
        }
        if (endDate) {
            params.push(endDate);
            query += ` AND d.doc_date::date <= $${params.length}::date`;
        }

        query += ` GROUP BY d.id, d.doc_no ORDER BY d.doc_date DESC, d.id DESC`;

        const { rows } = await pool.query(query, params);
        res.json({ success: true, data: rows });

    } catch (e) {
        console.error("Journal Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// 7. کاردکس کالا (Kardex)
// مسیر: /api/reports/kardex?product_id=X&owner_id=Y&date_from=Z&date_to=W
// ============================================================
router.get("/kardex", authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.member_id;
        const { product_id, owner_id, date_from, date_to } = req.query;

        if (!product_id) {
            return res.status(400).json({ success: false, error: "product_id الزامی است" });
        }

        let query = `
            SELECT
                it.id, it.type, it.transaction_type, it.qty, it.weight,
                it.batch_no, it.transaction_date, it.description,
                it.ref_receipt_id, it.ref_clearance_id, it.ref_exit_id,
                p.name AS product_name,
                c.name AS owner_name
            FROM public.inventory_transactions it
            LEFT JOIN public.products p ON it.product_id = p.id
            LEFT JOIN public.customers c ON it.owner_id = c.id
            WHERE it.member_id = $1 AND it.product_id = $2
        `;
        const params = [member_id, product_id];

        if (owner_id) {
            params.push(owner_id);
            query += ` AND it.owner_id = $${params.length}`;
        }
        if (date_from) {
            params.push(date_from);
            query += ` AND it.transaction_date >= $${params.length}`;
        }
        if (date_to) {
            params.push(date_to + 'T23:59:59');
            query += ` AND it.transaction_date <= $${params.length}`;
        }

        query += ` ORDER BY it.transaction_date ASC, it.created_at ASC`;

        const { rows } = await pool.query(query, params);

        let runQty = 0, runWeight = 0;
        const result = rows.map(row => {
            const q = Number(row.qty) || 0;
            const w = Number(row.weight) || 0;
            if (row.type === 'in') { runQty += q; runWeight += w; }
            else { runQty -= q; runWeight -= w; }

            return {
                ...row,
                qty: q,
                weight: w,
                running_qty: runQty,
                running_weight: runWeight
            };
        });

        res.json({ success: true, data: result });
    } catch (e) {
        console.error("❌ Kardex Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// 8. لیست موجودی انبار (Stock List)
// مسیر: /api/reports/stock-list?owner_id=X&product_id=Y&filter=actual|available
// ============================================================
router.get("/stock-list", authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.member_id;
        const { owner_id, product_id, filter: stockFilter } = req.query;

        const { search } = req.query;

        let query = `
            SELECT
                it.product_id,
                it.owner_id,
                it.batch_no,
                it.parent_batch_no,
                p.name AS product_name,
                c.name AS owner_name,
                SUM(CASE WHEN it.type = 'in' THEN it.qty ELSE 0 END) AS total_in_qty,
                SUM(CASE WHEN it.type = 'out' THEN it.qty ELSE 0 END) AS total_out_qty,
                SUM(CASE WHEN it.type = 'in' THEN it.weight ELSE 0 END) AS total_in_weight,
                SUM(CASE WHEN it.type = 'out' THEN it.weight ELSE 0 END) AS total_out_weight,
                SUM(CASE WHEN it.type = 'in' THEN it.qty ELSE -it.qty END) AS actual_qty,
                SUM(CASE WHEN it.type = 'in' THEN it.weight ELSE -it.weight END) AS actual_weight
            FROM public.inventory_transactions it
            LEFT JOIN public.products p ON it.product_id = p.id
            LEFT JOIN public.customers c ON it.owner_id = c.id
            WHERE it.member_id = $1
        `;
        const params = [member_id];

        if (owner_id) {
            params.push(owner_id);
            query += ` AND it.owner_id = $${params.length}`;
        }
        if (product_id) {
            params.push(product_id);
            query += ` AND it.product_id = $${params.length}`;
        }
        if (search) {
            params.push(`%${search}%`);
            const idx = params.length;
            query += ` AND (p.name ILIKE $${idx} OR c.name ILIKE $${idx} OR COALESCE(it.batch_no,'') ILIKE $${idx} OR COALESCE(it.parent_batch_no,'') ILIKE $${idx})`;
        }

        query += ` GROUP BY it.product_id, it.owner_id, it.batch_no, it.parent_batch_no, p.name, c.name ORDER BY c.name ASC NULLS LAST, p.name ASC, it.batch_no ASC`;

        const { rows } = await pool.query(query, params);

        let pendingMap = {};
        if (stockFilter === 'available') {
            const pendingParams = [member_id];
            let pendingWhere = 'WHERE member_id = $1 AND type = \'out\' AND transaction_type = \'clearance\'';
            if (owner_id) {
                pendingParams.push(owner_id);
                pendingWhere += ` AND owner_id = $${pendingParams.length}`;
            }
            const pendingSql = `
                SELECT product_id, owner_id,
                    SUM(qty) AS pending_qty, SUM(weight) AS pending_weight
                FROM public.inventory_transactions
                ${pendingWhere}
                GROUP BY product_id, owner_id
            `;
            const { rows: pendingRows } = await pool.query(pendingSql, pendingParams);
            pendingRows.forEach(r => {
                pendingMap[`${r.product_id}_${r.owner_id}`] = {
                    qty: Number(r.pending_qty) || 0,
                    weight: Number(r.pending_weight) || 0
                };
            });
        }

        const result = rows.map(row => {
            const actualQty = Number(row.actual_qty) || 0;
            const actualWeight = Number(row.actual_weight) || 0;
            const key = `${row.product_id}_${row.owner_id}`;
            const pending = pendingMap[key] || { qty: 0, weight: 0 };

            return {
                product_id: row.product_id,
                owner_id: row.owner_id,
                batch_no: row.batch_no || '',
                parent_row: row.parent_batch_no || '',
                product_name: row.product_name,
                owner_name: row.owner_name,
                total_in_qty: Number(row.total_in_qty) || 0,
                total_out_qty: Number(row.total_out_qty) || 0,
                total_in_weight: Number(row.total_in_weight) || 0,
                total_out_weight: Number(row.total_out_weight) || 0,
                actual_qty: actualQty,
                actual_weight: actualWeight,
                available_qty: actualQty - pending.qty,
                available_weight: actualWeight - pending.weight,
                pending_qty: pending.qty,
                pending_weight: pending.weight
            };
        });

        res.json({ success: true, data: result });
    } catch (e) {
        console.error("❌ Stock List Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// Dashboard Stats
// ============================================================
router.get("/dashboard-stats", authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.member_id;
        const today = new Date().toISOString().slice(0, 10);
        const threeDaysLater = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);

        const [receiptsRes, exitsRes, stockRes, rentalsRes, chequesRes, docsRes] = await Promise.all([
            pool.query(`SELECT COUNT(*)::int AS cnt FROM public.receipts WHERE member_id = $1 AND doc_date::date = $2`, [member_id, today]),
            pool.query(`SELECT COUNT(*)::int AS cnt FROM public.warehouse_exits WHERE member_id = $1 AND exit_date::date = $2`, [member_id, today]),
            pool.query(`
                SELECT COUNT(DISTINCT product_id)::int AS cnt
                FROM public.inventory_transactions
                WHERE member_id = $1
                GROUP BY member_id
                HAVING SUM(CASE WHEN type='in' THEN qty ELSE 0 END) - SUM(CASE WHEN type='out' THEN qty ELSE 0 END) > 0
            `, [member_id]).catch(() => ({ rows: [{ cnt: 0 }] })),
            pool.query(`SELECT COUNT(*)::int AS cnt FROM public.warehouse_rentals WHERE member_id = $1 AND status = 'active'`, [member_id]),
            pool.query(`SELECT COUNT(*)::int AS cnt FROM public.treasury_checks WHERE member_id = $1 AND due_date >= $2 AND due_date <= $3 AND status NOT IN ('cashed','returned','cancelled')`, [member_id, today, threeDaysLater]),
            pool.query(`SELECT COUNT(*)::int AS cnt FROM public.financial_documents WHERE member_id = $1 AND doc_date::date = $2`, [member_id, today]),
        ]);

        res.json({
            success: true,
            data: {
                today_receipts: receiptsRes.rows[0]?.cnt || 0,
                today_exits: exitsRes.rows[0]?.cnt || 0,
                total_stock: stockRes.rows[0]?.cnt || 0,
                active_rentals: rentalsRes.rows[0]?.cnt || 0,
                due_cheques: chequesRes.rows[0]?.cnt || 0,
                today_docs: docsRes.rows[0]?.cnt || 0,
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// Analytics Charts Data
// /api/reports/analytics?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
// ============================================================
router.get("/analytics", authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.member_id;
        const { startDate, endDate } = req.query;
        const dateFilter = (col) => {
            let sql = "";
            const p = [];
            if (startDate) { p.push(startDate); sql += ` AND ${col}::date >= $${p.length + 1}`; }
            if (endDate) { p.push(endDate); sql += ` AND ${col}::date <= $${p.length + 1}`; }
            return { sql, params: p };
        };

        const params = [member_id];
        let pIdx = 2;
        let dStart = startDate, dEnd = endDate;
        if (dStart) { params.push(dStart); }
        if (dEnd) { params.push(dEnd); }
        const startIdx = dStart ? (pIdx++) : null;
        const endIdx = dEnd ? (pIdx++) : null;
        const dFilt = (col) => {
            let s = "";
            if (startIdx) s += ` AND ${col}::date >= $${startIdx}`;
            if (endIdx) s += ` AND ${col}::date <= $${endIdx}`;
            return s;
        };

        const [receiptsDaily, exitsDaily, incomeExpense, topProducts, topCustomers, stockSummary, receiptStatusCount] = await Promise.all([
            pool.query(`
                SELECT doc_date::date AS day, COUNT(*)::int AS cnt, COALESCE(SUM(
                    (SELECT COALESCE(SUM(ri.weights_net),0) FROM public.receipt_items ri WHERE ri.receipt_id = r.id)
                ),0)::float8 AS total_weight
                FROM public.receipts r
                WHERE r.member_id = $1 ${dFilt('r.doc_date')}
                GROUP BY doc_date::date ORDER BY day
            `, params),

            pool.query(`
                SELECT exit_date::date AS day, COUNT(*)::int AS cnt
                FROM public.warehouse_exits
                WHERE member_id = $1 ${dFilt('exit_date')}
                GROUP BY exit_date::date ORDER BY day
            `, params),

            pool.query(`
                SELECT
                    COALESCE(SUM(CASE WHEN e.bed > 0 THEN e.bed ELSE 0 END),0)::float8 AS total_bed,
                    COALESCE(SUM(CASE WHEN e.bes > 0 THEN e.bes ELSE 0 END),0)::float8 AS total_bes
                FROM public.financial_entries e
                JOIN public.financial_documents d ON d.id = e.doc_id
                WHERE d.member_id = $1 ${dFilt('d.doc_date')}
            `, params),

            pool.query(`
                SELECT p.name AS product_name, 
                    SUM(CASE WHEN it.type='in' THEN it.qty ELSE 0 END)::int AS in_qty,
                    SUM(CASE WHEN it.type='out' THEN it.qty ELSE 0 END)::int AS out_qty,
                    SUM(CASE WHEN it.type='in' THEN it.weight ELSE 0 END)::float8 AS in_weight,
                    SUM(CASE WHEN it.type='out' THEN it.weight ELSE 0 END)::float8 AS out_weight
                FROM public.inventory_transactions it
                LEFT JOIN public.products p ON p.id = it.product_id
                WHERE it.member_id = $1 ${dFilt('it.transaction_date')}
                GROUP BY p.name ORDER BY in_weight DESC LIMIT 10
            `, params),

            pool.query(`
                SELECT c.name AS customer_name,
                    COUNT(DISTINCT r.id)::int AS receipt_count,
                    COALESCE(SUM(
                        (SELECT COALESCE(SUM(ri.weights_net),0) FROM public.receipt_items ri WHERE ri.receipt_id = r.id)
                    ),0)::float8 AS total_weight
                FROM public.receipts r
                LEFT JOIN public.customers c ON c.id = r.owner_id
                WHERE r.member_id = $1 ${dFilt('r.doc_date')}
                GROUP BY c.name ORDER BY total_weight DESC LIMIT 10
            `, params),

            pool.query(`
                SELECT
                    COUNT(DISTINCT it.product_id)::int AS product_count,
                    SUM(CASE WHEN it.type='in' THEN it.qty ELSE -it.qty END)::int AS net_qty,
                    SUM(CASE WHEN it.type='in' THEN it.weight ELSE -it.weight END)::float8 AS net_weight
                FROM public.inventory_transactions it
                WHERE it.member_id = $1
            `, [member_id]),

            pool.query(`
                SELECT status, COUNT(*)::int AS cnt
                FROM public.receipts
                WHERE member_id = $1 ${dFilt('doc_date')}
                GROUP BY status
            `, params),
        ]);

        res.json({
            success: true,
            data: {
                receiptsDaily: receiptsDaily.rows,
                exitsDaily: exitsDaily.rows,
                incomeExpense: incomeExpense.rows[0] || { total_bed: 0, total_bes: 0 },
                topProducts: topProducts.rows,
                topCustomers: topCustomers.rows,
                stockSummary: stockSummary.rows[0] || { product_count: 0, net_qty: 0, net_weight: 0 },
                receiptStatus: receiptStatusCount.rows,
            }
        });
    } catch (e) {
        console.error("Analytics Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;