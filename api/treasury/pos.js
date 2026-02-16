const express = require("express");
const router = express.Router();
const { pool } = require("../../supabaseAdmin");
const authMiddleware = require("../middleware/auth");

// Helper: تولید کد تفصیلی
async function generateNextTafsiliCode(client, memberId, type) {
    try {
        const res = await client.query(`
            SELECT MAX(code::int) as max_code 
            FROM public.accounting_tafsili 
            WHERE member_id = $1 AND tafsili_type = $2 AND code ~ '^[0-9]+$'
        `, [memberId, type]);

        const max = res.rows[0]?.max_code || 0;
        return String(max + 1).padStart(4, "0");
    } catch (e) {
        return "0001";
    }
}

// 1. لیست کارتخوان‌ها (GET)
router.get("/", authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.member_id;
        const { with_bank, with_tafsili } = req.query;

        let sql = `
            SELECT tp.* ${with_bank === 'true' ? ", json_build_object('id', tb.id, 'bank_name', tb.bank_name, 'account_no', tb.account_no) as treasury_banks" : ""}
            ${with_tafsili === 'true' ? ", json_build_object('id', t.id, 'code', t.code, 'title', t.title) as accounting_tafsili" : ""}
            FROM public.treasury_pos tp
            ${with_bank === 'true' ? "LEFT JOIN public.treasury_banks tb ON tp.bank_id = tb.id" : ""}
            ${with_tafsili === 'true' ? "LEFT JOIN public.accounting_tafsili t ON tp.tafsili_id = t.id" : ""}
            WHERE tp.member_id = $1
            ORDER BY tp.created_at DESC
        `;

        const { rows } = await pool.query(sql, [member_id]);
        res.json({ success: true, data: rows });

    } catch (e) {
        console.error("❌ GET POS Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// 2. دریافت یک کارتخوان
router.get("/:id", authMiddleware, async (req, res) => {
    try {
        const id = req.params.id;
        const member_id = req.user.member_id;

        const sql = `
            SELECT tp.*,
                   json_build_object('id', tb.id, 'bank_name', tb.bank_name, 'account_no', tb.account_no) as treasury_banks,
                   json_build_object('id', t.id, 'code', t.code, 'title', t.title) as accounting_tafsili
            FROM public.treasury_pos tp
            LEFT JOIN public.treasury_banks tb ON tp.bank_id = tb.id
            LEFT JOIN public.accounting_tafsili t ON tp.tafsili_id = t.id
            WHERE tp.id = $1 AND tp.member_id = $2
        `;

        const { rows } = await pool.query(sql, [id, member_id]);
        if (rows.length === 0) return res.status(404).json({ success: false, error: "کارتخوان یافت نشد" });

        res.json({ success: true, data: rows[0] });

    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 3. ایجاد کارتخوان
router.post("/", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const member_id = req.user.member_id;
        const { title, bank_id, terminal_id, description, is_active } = req.body;

        if (!title || !bank_id) return res.status(400).json({ success: false, error: "عنوان و حساب متصل الزامی است" });

        await client.query("BEGIN");

        // الف) چک کردن بانک
        const bankCheck = await client.query("SELECT id FROM public.treasury_banks WHERE id=$1 AND member_id=$2", [bank_id, member_id]);
        if (bankCheck.rowCount === 0) return res.status(403).json({ success: false, error: "بانک یافت نشد" });

        // ب) ثبت POS
        const insertPosSql = `
            INSERT INTO public.treasury_pos (
                member_id, title, bank_id, terminal_id, description, is_active, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
            RETURNING id, title
        `;
        const posRes = await client.query(insertPosSql, [member_id, title, bank_id, terminal_id, description, is_active !== false]);
        const newPos = posRes.rows[0];

        // ج) تفصیلی
        const nextCode = await generateNextTafsiliCode(client, member_id, 'pos');
        const insertTafsiliSql = `
            INSERT INTO public.accounting_tafsili (
                member_id, code, title, tafsili_type, ref_id, is_active, created_at
            ) VALUES ($1, $2, $3, 'pos', $4, true, NOW())
            RETURNING id
        `;
        const tafsiliRes = await client.query(insertTafsiliSql, [member_id, nextCode, title, newPos.id]);
        const tafsiliId = tafsiliRes.rows[0].id;

        // د) آپدیت POS
        await client.query("UPDATE public.treasury_pos SET tafsili_id = $1 WHERE id = $2", [tafsiliId, newPos.id]);

        await client.query("COMMIT");
        res.json({ success: true, data: { ...newPos, tafsili_id: tafsiliId }, message: "کارتخوان ایجاد شد" });

    } catch (e) {
        await client.query("ROLLBACK");
        console.error("❌ Create POS Error:", e);
        res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

// 4. ویرایش کارتخوان (PUT)
router.put("/:id", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const id = req.params.id;
        const member_id = req.user.member_id;
        const { title, bank_id, terminal_id, description, is_active } = req.body;

        const checkRes = await client.query("SELECT id, tafsili_id FROM public.treasury_pos WHERE id=$1 AND member_id=$2", [id, member_id]);
        if (checkRes.rowCount === 0) return res.status(404).json({ success: false, error: "کارتخوان یافت نشد" });
        const existing = checkRes.rows[0];

        await client.query("BEGIN");

        const updateSql = `
            UPDATE public.treasury_pos SET
                title=$1, bank_id=$2, terminal_id=$3, description=$4, is_active=$5
            WHERE id=$6 AND member_id=$7
            RETURNING *
        `;
        const updateRes = await client.query(updateSql, [title, bank_id, terminal_id, description, is_active !== false, id, member_id]);

        if (title && existing.tafsili_id) {
            await client.query("UPDATE public.accounting_tafsili SET title=$1 WHERE id=$2", [title, existing.tafsili_id]);
        }

        await client.query("COMMIT");
        res.json({ success: true, data: updateRes.rows[0], message: "کارتخوان ویرایش شد" });
    } catch (e) {
        await client.query("ROLLBACK");
        res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

// 5. حذف کارتخوان (DELETE)
router.delete("/:id", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const id = req.params.id;
        const member_id = req.user.member_id;

        const checkRes = await client.query("SELECT id, tafsili_id FROM public.treasury_pos WHERE id=$1 AND member_id=$2", [id, member_id]);
        if (checkRes.rowCount === 0) return res.status(404).json({ success: false, error: "یافت نشد" });
        const pos = checkRes.rows[0];

        await client.query("BEGIN");
        await client.query("DELETE FROM public.treasury_pos WHERE id=$1", [id]);
        if (pos.tafsili_id) await client.query("DELETE FROM public.accounting_tafsili WHERE id=$1", [pos.tafsili_id]);
        await client.query("COMMIT");

        res.json({ success: true, message: "کارتخوان حذف شد" });
    } catch (e) {
        await client.query("ROLLBACK");
        if (e.code === '23503') return res.status(409).json({ success: false, error: "امکان حذف وجود ندارد" });
        res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

module.exports = router;