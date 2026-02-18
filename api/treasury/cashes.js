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
        console.error("Code Gen Error:", e);
        return "0001";
    }
}

// 1. لیست صندوق‌ها (GET)
router.get("/", authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.member_id;
        const { with_tafsili } = req.query;

        let sql = `
            SELECT tc.* ${with_tafsili === 'true' ? ", json_build_object('id', t.id, 'code', t.code, 'title', t.title) as accounting_tafsili" : ""}
            FROM public.treasury_cashes tc
            ${with_tafsili === 'true' ? "LEFT JOIN public.accounting_tafsili t ON tc.tafsili_id = t.id" : ""}
            WHERE tc.member_id = $1
            ORDER BY tc.created_at DESC
        `;

        const { rows } = await pool.query(sql, [member_id]);
        res.json({ success: true, data: rows });

    } catch (e) {
        console.error("❌ GET Cashes Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// 2. دریافت یک صندوق (GET One)
router.get("/:id", authMiddleware, async (req, res) => {
    try {
        const id = req.params.id;
        const member_id = req.user.member_id;

        const sql = `
            SELECT tc.*, 
                   json_build_object('id', t.id, 'code', t.code, 'title', t.title) as accounting_tafsili
            FROM public.treasury_cashes tc
            LEFT JOIN public.accounting_tafsili t ON tc.tafsili_id = t.id
            WHERE tc.id = $1 AND tc.member_id = $2
        `;

        const { rows } = await pool.query(sql, [id, member_id]);
        if (rows.length === 0) return res.status(404).json({ success: false, error: "صندوق یافت نشد" });

        res.json({ success: true, data: rows[0] });

    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 3. ایجاد صندوق (POST)
router.post("/", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const member_id = req.user.member_id;
        const { title, initial_balance, description, is_active } = req.body;

        if (!title) return res.status(400).json({ success: false, error: "عنوان صندوق الزامی است" });

        await client.query("BEGIN");

        // الف) ثبت صندوق
        const insertCashSql = `
            INSERT INTO public.treasury_cashes (
                member_id, title, initial_balance, description, is_active, created_at
            ) VALUES ($1, $2, $3, $4, $5, NOW())
            RETURNING id, title
        `;
        const cashRes = await client.query(insertCashSql, [
            member_id, title, initial_balance || 0, description, is_active !== false
        ]);
        const newCash = cashRes.rows[0];

        // ب) تولید کد و ثبت تفصیلی
        const nextCode = await generateNextTafsiliCode(client, member_id, 'cash');

        const insertTafsiliSql = `
            INSERT INTO public.accounting_tafsili (
                member_id, code, title, tafsili_type, ref_id, is_active, created_at
            ) VALUES ($1, $2, $3, 'cash', $4, true, NOW())
            RETURNING id
        `;
        const tafsiliRes = await client.query(insertTafsiliSql, [member_id, nextCode, title, newCash.id]);
        const tafsiliId = tafsiliRes.rows[0].id;

        // ج) اتصال صندوق به تفصیلی
        await client.query("UPDATE public.treasury_cashes SET tafsili_id = $1 WHERE id = $2", [tafsiliId, newCash.id]);

        await client.query("COMMIT");

        res.json({ success: true, data: { ...newCash, tafsili_id: tafsiliId }, message: "صندوق ایجاد شد" });

    } catch (e) {
        await client.query("ROLLBACK");
        console.error("❌ Create Cash Error:", e);
        res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

// 4. ویرایش صندوق (PUT)
router.put("/:id", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const id = req.params.id;
        const member_id = req.user.member_id;
        const { title, initial_balance, description, is_active } = req.body;

        const checkRes = await client.query("SELECT id, tafsili_id FROM public.treasury_cashes WHERE id=$1 AND member_id=$2", [id, member_id]);
        if (checkRes.rowCount === 0) return res.status(404).json({ success: false, error: "صندوق یافت نشد" });

        const existing = checkRes.rows[0];

        await client.query("BEGIN");

        const updateSql = `
            UPDATE public.treasury_cashes SET
                title=$1, initial_balance=$2, description=$3, is_active=$4
            WHERE id=$5 AND member_id=$6
            RETURNING *
        `;
        const updateRes = await client.query(updateSql, [title, initial_balance, description, is_active, id, member_id]);

        // آپدیت نام تفصیلی
        if (title && existing.tafsili_id) {
            await client.query("UPDATE public.accounting_tafsili SET title=$1 WHERE id=$2", [title, existing.tafsili_id]);
        }

        await client.query("COMMIT");
        res.json({ success: true, data: updateRes.rows[0], message: "صندوق ویرایش شد" });

    } catch (e) {
        await client.query("ROLLBACK");
        res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

// 5. حذف صندوق (DELETE)
router.delete("/:id", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const id = req.params.id;
        const member_id = req.user.member_id;

        const checkRes = await client.query("SELECT id, tafsili_id FROM public.treasury_cashes WHERE id=$1 AND member_id=$2", [id, member_id]);
        if (checkRes.rowCount === 0) return res.status(404).json({ success: false, error: "صندوق یافت نشد" });
        const cash = checkRes.rows[0];

        await client.query("BEGIN");
        await client.query("DELETE FROM public.treasury_cashes WHERE id=$1", [id]);
        if (cash.tafsili_id) {
            await client.query("DELETE FROM public.accounting_tafsili WHERE id=$1", [cash.tafsili_id]);
        }
        await client.query("COMMIT");

        res.json({ success: true, message: "صندوق حذف شد" });

    } catch (e) {
        await client.query("ROLLBACK");
        if (e.code === '23503') return res.status(409).json({ success: false, error: "صندوق دارای تراکنش است" });
        res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

module.exports = router;