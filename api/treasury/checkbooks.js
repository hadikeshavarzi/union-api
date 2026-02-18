const express = require("express");
const router = express.Router();
const { pool } = require("../../supabaseAdmin");
const authMiddleware = require("../middleware/auth");

// 1. لیست دسته‌چک‌ها (GET)
router.get("/", authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.member_id;
        const { bank_id } = req.query;

        let sql = `
            SELECT tc.*, 
                   json_build_object('id', tb.id, 'bank_name', tb.bank_name, 'account_no', tb.account_no) as treasury_banks
            FROM public.treasury_checkbooks tc
            LEFT JOIN public.treasury_banks tb ON tc.bank_id = tb.id
            WHERE tc.member_id = $1
        `;
        const params = [member_id];

        if (bank_id) {
            sql += " AND tc.bank_id = $2";
            params.push(bank_id);
        }

        sql += " ORDER BY tc.created_at DESC";

        const { rows } = await pool.query(sql, params);
        res.json({ success: true, data: rows });
    } catch (e) {
        console.error("❌ GET Checkbooks Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// 2. ایجاد دسته‌چک جدید (POST)
router.post("/", authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.member_id;
        const { bank_id, serial_start, serial_end, description } = req.body;

        if (!bank_id || !serial_start || !serial_end) {
            return res.status(400).json({ success: false, error: "بانک و بازه سریال الزامی است" });
        }

        const sql = `
            INSERT INTO public.treasury_checkbooks (
                member_id, bank_id, serial_start, serial_end, current_serial, status, description, created_at
            ) VALUES ($1, $2, $3, $4, $3, 'active', $5, NOW())
            RETURNING *
        `;

        const { rows } = await pool.query(sql, [member_id, bank_id, serial_start, serial_end, description]);
        res.json({ success: true, data: rows[0], message: "دسته‌چک با موفقیت ثبت شد" });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 3. ویرایش دسته‌چک (PUT)
router.put("/:id", authMiddleware, async (req, res) => {
    try {
        const id = req.params.id;
        const member_id = req.user.member_id;
        const { bank_id, serial_start, serial_end, description, status } = req.body;

        const updateSql = `
            UPDATE public.treasury_checkbooks SET
                bank_id = COALESCE($1, bank_id),
                serial_start = COALESCE($2, serial_start),
                serial_end = COALESCE($3, serial_end),
                description = COALESCE($4, description),
                status = COALESCE($5, status)
            WHERE id = $6 AND member_id = $7
            RETURNING *
        `;

        const { rows } = await pool.query(updateSql, [bank_id, serial_start, serial_end, description, status, id, member_id]);
        if (rows.length === 0) return res.status(404).json({ success: false, error: "دسته‌چک یافت نشد" });

        res.json({ success: true, data: rows[0], message: "دسته‌چک ویرایش شد" });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 4. حذف دسته‌چک (DELETE)
router.delete("/:id", authMiddleware, async (req, res) => {
    try {
        const id = req.params.id;
        const member_id = req.user.member_id;

        const { rowCount } = await pool.query(
            "DELETE FROM public.treasury_checkbooks WHERE id = $1 AND member_id = $2",
            [id, member_id]
        );

        if (rowCount === 0) return res.status(404).json({ success: false, error: "دسته‌چک یافت نشد" });
        res.json({ success: true, message: "حذف شد" });
    } catch (e) {
        if (e.code === '23503') return res.status(409).json({ success: false, error: "این دسته‌چک دارای چک صادر شده است" });
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;