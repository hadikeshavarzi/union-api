// api/financial/documents.js
const express = require("express");
const { pool } = require("../../supabaseAdmin");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

/* GET ALL DOCUMENTS */
router.get("/", authMiddleware, async (req, res) => {
    try {
        const { search, limit = 500 } = req.query;
        const member_id = req.user.id;

        let queryText = `
            SELECT 
                d.id, d.doc_date, d.description, d.doc_no, d.created_at, d.doc_type, d.status,
                COALESCE(SUM(e.bed), 0) as total_amount
            FROM public.financial_documents d
            LEFT JOIN public.financial_entries e ON d.id = e.doc_id
            WHERE d.member_id = $1
        `;

        const queryParams = [member_id];
        let paramCounter = 2;

        if (search) {
            queryText += ` AND d.description ILIKE $${paramCounter}`;
            queryParams.push(`%${search}%`);
            paramCounter++;
        }

        queryText += ` GROUP BY d.id ORDER BY d.created_at DESC LIMIT $${paramCounter}`;
        queryParams.push(Number(limit));

        const result = await pool.query(queryText, queryParams);

        return res.json({ success: true, data: result.rows });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* GET ONE DOCUMENT */
router.get("/:id", authMiddleware, async (req, res) => {
    try {
        const id = req.params.id;
        const member_id = req.user.id;

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
                            'moein', (SELECT json_build_object('id', m.id, 'code', m.code, 'title', m.title) FROM public.accounting_moein m WHERE m.id = e.moein_id),
                            'tafsili', (SELECT json_build_object('id', t.id, 'code', t.code, 'title', t.title) FROM public.accounting_tafsili t WHERE t.id = e.tafsili_id)
                        )
                    )
                    FROM public.financial_entries e
                    WHERE e.doc_id = d.id
                ) as financial_entries
            FROM public.financial_documents d
            WHERE d.id = $1 AND d.member_id = $2
        `;

        const result = await pool.query(query, [id, member_id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "سند یافت نشد" });
        }

        return res.json({ success: true, data: result.rows[0] });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* CREATE DOCUMENT WITH ENTRIES */
router.post("/create-with-entries", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const { header, entries } = req.body;
        const member_id = req.user.id;

        if (!header || !entries || entries.length === 0) {
            return res.status(400).json({ success: false, error: "اطلاعات سند ناقص است" });
        }

        await client.query('BEGIN');

        // ثبت هدر
        const docQuery = `
            INSERT INTO public.financial_documents 
            (member_id, doc_date, description, status, doc_type, doc_no)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
        `;
        const docNo = header.doc_no || header.manual_no || null;

        const docRes = await client.query(docQuery, [
            member_id,
            header.doc_date,
            header.description,
            header.status || 'confirmed',
            'manual',
            docNo
        ]);
        const newDoc = docRes.rows[0];

        // ثبت آرتیکل‌ها
        for (const entry of entries) {
            await client.query(`
                INSERT INTO public.financial_entries 
                (doc_id, member_id, moein_id, tafsili_id, description, bed, bes)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [
                newDoc.id,
                member_id,
                entry.moein_id,
                entry.tafsili_id,
                entry.description,
                Number(entry.bed) || 0,
                Number(entry.bes) || 0
            ]);
        }

        await client.query('COMMIT');

        return res.json({ success: true, data: newDoc, message: "سند با موفقیت ثبت شد" });

    } catch (e) {
        await client.query('ROLLBACK');
        return res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

/* UPDATE DOCUMENT */
router.put("/:id", authMiddleware, async (req, res) => {
    try {
        const id = req.params.id;
        const member_id = req.user.id;
        const payload = { ...req.body };

        delete payload.id;
        delete payload.member_id;
        delete payload.created_at;
        delete payload.financial_entries;

        const keys = Object.keys(payload);
        if (keys.length === 0) return res.status(400).json({ error: "No data" });

        const setClause = keys.map((key, index) => `${key} = $${index + 1}`).join(", ");
        const values = Object.values(payload);
        values.push(id);
        values.push(member_id);

        const query = `
            UPDATE public.financial_documents 
            SET ${setClause} 
            WHERE id = $${values.length - 1} AND member_id = $${values.length} 
            RETURNING *
        `;

        const result = await pool.query(query, values);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "سند یافت نشد" });
        }

        return res.json({ success: true, data: result.rows[0], message: "سند ویرایش شد" });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* DELETE DOCUMENT */
router.delete("/:id", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const id = req.params.id;
        const member_id = req.user.id;

        await client.query('BEGIN');
        await client.query('DELETE FROM public.financial_entries WHERE doc_id = $1 AND member_id = $2', [id, member_id]);
        const resDoc = await client.query('DELETE FROM public.financial_documents WHERE id = $1 AND member_id = $2', [id, member_id]);

        if (resDoc.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: "سند یافت نشد" });
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