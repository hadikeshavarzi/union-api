// union-api/api/accounting/index.js
const express = require("express");
const { pool } = require("../../supabaseAdmin");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

// ============================================================
// 1. دریافت لیست اسناد
// آدرس نهایی: GET /api/accounting/documents
// ============================================================
router.get("/documents", authMiddleware, async (req, res) => {
    try {
        const { search, limit = 500, date_from, date_to, doc_type } = req.query;
        const member_id = req.user.member_id;

        let queryText = `
            SELECT
                d.id,
                d.doc_date,
                d.description,
                d.manual_no,
                d.doc_no,
                d.status,
                d.doc_type,
                d.created_at,
                (SELECT COALESCE(SUM(bed), 0) FROM public.financial_entries WHERE doc_id = d.id) as total_amount,
                (SELECT json_agg(json_build_object(
                    'id', e.id, 'bed', e.bed, 'bes', e.bes, 'description', e.description,
                    'moein_id', e.moein_id, 'tafsili_id', e.tafsili_id,
                    'accounting_moein', json_build_object('code', m.code, 'title', m.title),
                    'accounting_tafsili', CASE WHEN t.id IS NOT NULL THEN json_build_object('code', t.code, 'title', t.title) ELSE NULL END
                ) ORDER BY e.id)
                FROM public.financial_entries e
                LEFT JOIN public.accounting_moein m ON m.id = e.moein_id
                LEFT JOIN public.accounting_tafsili t ON t.id = e.tafsili_id
                WHERE e.doc_id = d.id) as financial_entries
            FROM public.financial_documents d
            WHERE d.member_id = $1
        `;

        const queryParams = [member_id];
        let paramCounter = 2;

        if (date_from) {
            queryText += ` AND d.doc_date >= $${paramCounter}`;
            queryParams.push(date_from);
            paramCounter++;
        }

        if (date_to) {
            queryText += ` AND d.doc_date <= $${paramCounter}`;
            queryParams.push(date_to);
            paramCounter++;
        }

        if (doc_type && doc_type !== 'all') {
            queryText += ` AND d.doc_type = $${paramCounter}`;
            queryParams.push(doc_type);
            paramCounter++;
        }

        if (search) {
            queryText += ` AND (d.description ILIKE $${paramCounter} OR d.manual_no ILIKE $${paramCounter} OR d.doc_no ILIKE $${paramCounter})`;
            queryParams.push(`%${search}%`);
            paramCounter++;
        }

        queryText += ` ORDER BY d.doc_date DESC, d.created_at DESC LIMIT $${paramCounter}`;
        queryParams.push(Number(limit));

        const result = await pool.query(queryText, queryParams);

        return res.json({ success: true, data: result.rows });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// 2. دریافت یک سند خاص
// آدرس نهایی: GET /api/accounting/documents/:id
// ============================================================
// ============================================================
// 2. دریافت یک سند خاص (همراه با جزئیات)
// ============================================================
router.get("/documents/:id", authMiddleware, async (req, res) => {
    try {
        const id = req.params.id;
        const member_id = req.user.member_id;

        const query = `
            SELECT 
                d.*,
                (
                    SELECT json_agg(
                        json_build_object(
                            'id', e.id,
                            'bed', e.bed,
                            'bes', e.bes,
                            'description', e.description,
                            'moein_id', e.moein_id,
                            'tafsili_id', e.tafsili_id,
                            
                            -- اصلاحات مهم:
                            -- 1. حذف tafsili_type چون در دیتابیس نیست
                            -- 2. اضافه کردن کدها برای نمایش در جدول
                            'moein_code', m.code,
                            'moein_title', m.title,
                            'tafsili_code', t.code,
                            'tafsili_title', t.title
                        )
                    )
                    FROM public.financial_entries e
                    LEFT JOIN public.accounting_moein m ON m.id = e.moein_id
                    LEFT JOIN public.accounting_tafsili t ON t.id = e.tafsili_id
                    WHERE e.doc_id = d.id
                ) as entries
            FROM public.financial_documents d
            WHERE d.id = $1 AND d.member_id = $2
        `;

        const result = await pool.query(query, [id, member_id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "سند یافت نشد" });
        }

        // اگر entries نال بود (سند بدون ردیف)، آرایه خالی بگذار
        const doc = result.rows[0];
        if (!doc.entries) doc.entries = [];

        return res.json({ success: true, data: doc });
    } catch (e) {
        console.error("Get Document Detail Error:", e); // لاگ کردن ارور برای دیباگ
        return res.status(500).json({ success: false, error: e.message });
    }
});
// ============================================================
// 3. ثبت سند جدید (Create)
// آدرس نهایی: POST /api/accounting/documents
// ============================================================
router.post("/documents", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const { doc_date, description, manual_no, entries } = req.body;

        // هندل کردن دیتایی که ممکن است داخل header باشد
        const finalDate = doc_date || req.body.header?.doc_date;
        const finalDesc = description || req.body.header?.description;
        const finalNo = manual_no || req.body.header?.manual_no;
        const finalEntries = entries || req.body.entries;

        const member_id = req.user.member_id;

        if (!finalEntries || finalEntries.length === 0) {
            return res.status(400).json({ success: false, error: "سند باید حداقل یک ردیف داشته باشد" });
        }

        await client.query('BEGIN');

        const { rows: noRows } = await client.query(
            "SELECT COALESCE(MAX(doc_no), 0) + 1 AS next_no FROM public.financial_documents WHERE member_id = $1",
            [member_id]
        );
        const nextDocNo = noRows[0].next_no;

        const docQuery = `
            INSERT INTO public.financial_documents 
            (member_id, doc_date, description, manual_no, doc_no, doc_type, status, created_at)
            VALUES ($1, $2, $3, $4, $5, 'manual', 'confirmed', NOW())
            RETURNING id, doc_no
        `;

        const docRes = await client.query(docQuery, [
            member_id,
            finalDate,
            finalDesc,
            finalNo,
            nextDocNo
        ]);
        const newDocId = docRes.rows[0].id;

        // 2. ثبت آرتیکل‌ها (ردیف‌های سند)
        for (const entry of finalEntries) {
            // ⚠️ اصلاح: حذف tafsili_type از کوئری
            await client.query(`
                INSERT INTO public.financial_entries 
                (doc_id, member_id, moein_id, tafsili_id, description, bed, bes)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [
                newDocId,
                member_id,
                entry.moein_id,
                entry.tafsili_id || null,
                entry.description || finalDesc,
                Number(entry.bed) || 0,
                Number(entry.bes) || 0
                // پارامتر هشتم (tafsili_type) حذف شد
            ]);
        }

        await client.query('COMMIT');

        return res.json({ success: true, message: "سند با موفقیت ثبت شد", id: newDocId });

    } catch (e) {
        await client.query('ROLLBACK');
        console.error("Accounting Insert Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});
// ============================================================
// 4-A. ویرایش سند (Update)
// آدرس نهایی: PUT /api/accounting/documents/:id
// ============================================================
router.put("/documents/:id", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const id = req.params.id;
        const member_id = req.user.member_id;
        const { doc_date, description, manual_no, entries } = req.body;

        const existing = await client.query("SELECT id, doc_type FROM public.financial_documents WHERE id = $1 AND member_id = $2", [id, member_id]);
        if (!existing.rows.length) return res.status(404).json({ success: false, error: "سند یافت نشد" });
        if (existing.rows[0].doc_type === "system") return res.status(400).json({ success: false, error: "اسناد سیستمی قابل ویرایش نیستند" });

        await client.query("BEGIN");

        await client.query(
            "UPDATE public.financial_documents SET doc_date = COALESCE($1, doc_date), description = COALESCE($2, description), manual_no = COALESCE($3, manual_no) WHERE id = $4",
            [doc_date || null, description || null, manual_no || null, id]
        );

        if (entries && Array.isArray(entries) && entries.length > 0) {
            await client.query("DELETE FROM public.financial_entries WHERE doc_id = $1", [id]);
            for (const e of entries) {
                await client.query(
                    "INSERT INTO public.financial_entries (doc_id, moein_id, tafsili_id, bed, bes, description, member_id) VALUES ($1,$2,$3,$4,$5,$6,$7)",
                    [id, e.moein_id, e.tafsili_id || null, e.bed || 0, e.bes || 0, e.description || "", member_id]
                );
            }
        }

        await client.query("COMMIT");
        res.json({ success: true, message: "سند ویرایش شد" });
    } catch (e) {
        await client.query("ROLLBACK");
        console.error("Accounting Update Error:", e);
        res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

// ============================================================
// 4-B. حذف سند (Delete)
// آدرس نهایی: DELETE /api/accounting/documents/:id
// ============================================================
router.delete("/documents/:id", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const id = req.params.id;
        const member_id = req.user.member_id;

        await client.query('BEGIN');

        // اول ردیف‌ها را پاک کن
        await client.query('DELETE FROM public.financial_entries WHERE doc_id = $1', [id]);

        // بعد خود سند را پاک کن (با شرط مالکیت)
        const resDoc = await client.query('DELETE FROM public.financial_documents WHERE id = $1 AND member_id = $2', [id, member_id]);

        if (resDoc.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: "سند یافت نشد یا دسترسی ندارید" });
        }

        await client.query('COMMIT');
        return res.json({ success: true, message: "سند حذف شد" });

    } catch (e) {
        await client.query('ROLLBACK');
        return res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

module.exports = router;