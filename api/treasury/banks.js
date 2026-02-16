const express = require("express");
const router = express.Router();
const { pool } = require("../../supabaseAdmin"); // اتصال دیتابیس
const authMiddleware = require("../middleware/auth");

// ============================================================
// 1. GET / (لیست بانک‌ها با جستجو و صفحه‌بندی)
// ============================================================
router.get("/", authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.member_id;
        const { limit = 100, offset = 0, search, with_tafsili } = req.query;

        const params = [member_id];
        let whereClause = `WHERE tb.member_id = $1`;
        let paramIdx = 2;

        // جستجو
        if (search) {
            params.push(`%${search}%`);
            whereClause += ` AND (tb.bank_name ILIKE $${paramIdx} OR tb.account_no ILIKE $${paramIdx} OR tb.card_no ILIKE $${paramIdx})`;
            paramIdx++;
        }

        // ساخت کوئری اصلی
        let sql = `
            SELECT tb.* ${with_tafsili === 'true' ? ", json_build_object('id', t.id, 'code', t.code, 'title', t.title) as accounting_tafsili" : ""}
            FROM public.treasury_banks tb
            ${with_tafsili === 'true' ? "LEFT JOIN public.accounting_tafsili t ON tb.tafsili_id = t.id" : ""}
            ${whereClause}
            ORDER BY tb.created_at DESC
            LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
        `;

        // پارامترهای Limit و Offset
        params.push(parseInt(limit), parseInt(offset));

        const { rows } = await pool.query(sql, params);

        // شمارش کل (برای صفحه‌بندی)
        const countRes = await pool.query(
            `SELECT COUNT(*)::bigint as total FROM public.treasury_banks tb ${whereClause}`,
            params.slice(0, paramIdx - 1)
        );

        res.json({
            success: true,
            data: rows,
            total: Number(countRes.rows[0]?.total || 0)
        });

    } catch (e) {
        console.error("❌ GET Banks Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// 2. GET /:id (دریافت یک بانک)
// ============================================================
router.get("/:id", authMiddleware, async (req, res) => {
    try {
        const id = req.params.id;
        const member_id = req.user.member_id;

        const sql = `
            SELECT tb.*, 
                   json_build_object('id', t.id, 'code', t.code, 'title', t.title) as accounting_tafsili
            FROM public.treasury_banks tb
            LEFT JOIN public.accounting_tafsili t ON tb.tafsili_id = t.id
            WHERE tb.id = $1 AND tb.member_id = $2
        `;

        const { rows } = await pool.query(sql, [id, member_id]);

        if (rows.length === 0) {
            return res.status(404).json({ success: false, error: "بانک یافت نشد" });
        }

        res.json({ success: true, data: rows[0] });

    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// 3. POST / (ثبت بانک جدید + ساخت تفصیلی خودکار)
// ============================================================
router.post("/", authMiddleware, async (req, res) => {
    const client = await pool.connect(); // شروع تراکنش
    try {
        const member_id = req.user.member_id;
        const body = req.body;

        if (!body.bank_name) {
            return res.status(400).json({ success: false, error: "نام بانک الزامی است" });
        }

        await client.query("BEGIN");

        // الف) ثبت بانک
        const insertBankSql = `
            INSERT INTO public.treasury_banks (
                member_id, bank_name, account_no, card_no, shaba_no, 
                initial_balance, description, is_active, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
            RETURNING id, bank_name, account_no, card_no
        `;

        const bankValues = [
            member_id, body.bank_name, body.account_no, body.card_no, body.shaba_no,
            body.initial_balance || 0, body.description, body.is_active !== false
        ];

        const bankRes = await client.query(insertBankSql, bankValues);
        const newBank = bankRes.rows[0];

        // ب) تولید کد تفصیلی
        const nextCode = await generateNextTafsiliCode(client, member_id, 'bank_account');
        const tafsiliTitle = `${newBank.bank_name} - ${newBank.account_no || newBank.card_no || 'بدون شماره'}`;

        // ج) ثبت حساب تفصیلی
        const insertTafsiliSql = `
            INSERT INTO public.accounting_tafsili (
                member_id, code, title, tafsili_type, ref_id, is_active, created_at
            ) VALUES ($1, $2, $3, 'bank_account', $4, true, NOW())
            RETURNING id
        `;
        const tafsiliRes = await client.query(insertTafsiliSql, [member_id, nextCode, tafsiliTitle, newBank.id]);
        const newTafsiliId = tafsiliRes.rows[0].id;

        // د) آپدیت بانک برای اتصال به تفصیلی
        await client.query(
            "UPDATE public.treasury_banks SET tafsili_id = $1 WHERE id = $2",
            [newTafsiliId, newBank.id]
        );

        await client.query("COMMIT");

        res.json({
            success: true,
            data: { ...newBank, tafsili_id: newTafsiliId },
            message: "بانک و حساب تفصیلی با موفقیت ایجاد شدند"
        });

    } catch (e) {
        await client.query("ROLLBACK");
        console.error("❌ Create Bank Error:", e);
        if (e.code === '23505') {
            return res.status(409).json({ success: false, error: "اطلاعات تکراری است" });
        }
        res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

// ============================================================
// 4. PUT /:id (ویرایش بانک)
// ============================================================
router.put("/:id", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const id = req.params.id;
        const member_id = req.user.member_id;
        const body = req.body;

        // چک کردن وجود بانک
        const checkRes = await client.query(
            "SELECT id, tafsili_id FROM public.treasury_banks WHERE id = $1 AND member_id = $2",
            [id, member_id]
        );
        if (checkRes.rowCount === 0) return res.status(404).json({ success: false, error: "بانک یافت نشد" });

        const existingBank = checkRes.rows[0];

        await client.query("BEGIN");

        // آپدیت بانک
        const updateSql = `
            UPDATE public.treasury_banks SET
                bank_name=$1, account_no=$2, card_no=$3, shaba_no=$4, 
                initial_balance=$5, description=$6, is_active=$7
            WHERE id=$8 AND member_id=$9
            RETURNING *
        `;
        const values = [
            body.bank_name, body.account_no, body.card_no, body.shaba_no,
            body.initial_balance || 0, body.description, body.is_active !== false,
            id, member_id
        ];

        const updateRes = await client.query(updateSql, values);
        const updatedBank = updateRes.rows[0];

        // آپدیت نام تفصیلی (اگر متصل باشد)
        if (existingBank.tafsili_id) {
            const newTitle = `${updatedBank.bank_name} - ${updatedBank.account_no || updatedBank.card_no || 'بدون شماره'}`;
            await client.query(
                "UPDATE public.accounting_tafsili SET title = $1 WHERE id = $2",
                [newTitle, existingBank.tafsili_id]
            );
        }

        await client.query("COMMIT");

        res.json({ success: true, data: updatedBank, message: "بانک ویرایش شد" });

    } catch (e) {
        await client.query("ROLLBACK");
        res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

// ============================================================
// 5. DELETE /:id (حذف بانک)
// ============================================================
router.delete("/:id", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const id = req.params.id;
        const member_id = req.user.member_id;

        // دریافت اطلاعات برای حذف تفصیلی
        const checkRes = await client.query(
            "SELECT id, tafsili_id FROM public.treasury_banks WHERE id = $1 AND member_id = $2",
            [id, member_id]
        );

        if (checkRes.rowCount === 0) return res.status(404).json({ success: false, error: "بانک یافت نشد" });
        const bank = checkRes.rows[0];

        await client.query("BEGIN");

        // حذف بانک
        await client.query("DELETE FROM public.treasury_banks WHERE id = $1", [id]);

        // حذف تفصیلی (اگر وجود دارد)
        if (bank.tafsili_id) {
            await client.query("DELETE FROM public.accounting_tafsili WHERE id = $1", [bank.tafsili_id]);
        }

        await client.query("COMMIT");
        res.json({ success: true, message: "بانک و حساب تفصیلی مربوطه حذف شدند" });

    } catch (e) {
        await client.query("ROLLBACK");
        if (e.code === '23503') {
            return res.status(409).json({ success: false, error: "این بانک دارای تراکنش است و قابل حذف نیست" });
        }
        res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

// ============================================================
// Helper: تولید کد تفصیلی
// ============================================================
async function generateNextTafsiliCode(client, memberId, type) {
    try {
        const { rows } = await client.query(`
            SELECT code FROM public.accounting_tafsili 
            WHERE member_id = $1 AND tafsili_type = $2 
            ORDER BY code DESC LIMIT 1
        `, [memberId, type]);

        let nextNum = 1;
        if (rows.length > 0 && !isNaN(Number(rows[0].code))) {
            nextNum = Number(rows[0].code) + 1;
        }
        return String(nextNum).padStart(4, "0");
    } catch (e) {
        console.error("Code Gen Error:", e);
        return "0001";
    }
}

module.exports = router;