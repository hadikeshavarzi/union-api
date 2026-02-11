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
        const { type } = req.query; // 'customer', 'supplier', etc.
        const member_id = req.user.id;

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
        const { type } = req.query; // 'bank' or 'cash'
        const member_id = req.user.id;

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
        const member_id = req.user.id;

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
        const member_id = req.user.id;

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
        const member_id = req.user.id;

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
        const member_id = req.user.id;

        // استفاده از JSON_AGG برای برگرداندن سند به همراه ردیف‌هایش در یک کوئری
        let query = `
            SELECT 
                d.id, d.doc_date, d.manual_no, d.description, d.status,
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
            query += ` AND d.doc_date >= $${params.length}`;
        }
        if (endDate) {
            params.push(endDate);
            query += ` AND d.doc_date <= $${params.length}`;
        }

        query += ` GROUP BY d.id ORDER BY d.doc_date DESC, d.id DESC`;

        const { rows } = await pool.query(query, params);
        res.json({ success: true, data: rows });

    } catch (e) {
        console.error("Journal Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;