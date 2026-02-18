// api/treasury/checks.js
const express = require("express");
const { pool } = require("../../supabaseAdmin"); // اتصال به دیتابیس
const authMiddleware = require("../middleware/auth");

const router = express.Router();

/* GET ALL CHECKS */
router.get("/", authMiddleware, async (req, res) => {
    try {
        const {
            status, // pending, passed, bounced, ...
            type,   // payable, receivable
            limit = 100,
            search,
            checkbook_id
        } = req.query;

        const member_id = req.user.member_id;

        // کوئری با اتصال به دسته‌چک و بانک
        let queryText = `
            SELECT 
                c.*,
                json_build_object(
                    'id', cb.id,
                    'serial_start', cb.serial_start,
                    'serial_end', cb.serial_end,
                    'bank_name', b.bank_name
                ) as checkbook
            FROM public.treasury_checks c
            LEFT JOIN public.treasury_checkbooks cb ON c.checkbook_id = cb.id
            LEFT JOIN public.treasury_banks b ON cb.bank_id = b.id
            WHERE c.member_id = $1
        `;

        const queryParams = [member_id];
        let paramCounter = 2;

        if (status) {
            queryText += ` AND c.status = $${paramCounter}`;
            queryParams.push(status);
            paramCounter++;
        }

        if (type) {
            queryText += ` AND c.type = $${paramCounter}`;
            queryParams.push(type);
            paramCounter++;
        }

        if (checkbook_id) {
            queryText += ` AND c.checkbook_id = $${paramCounter}`;
            queryParams.push(checkbook_id);
            paramCounter++;
        }

        if (search) {
            queryText += ` AND (c.check_number ILIKE $${paramCounter} OR c.sayad_number ILIKE $${paramCounter})`;
            queryParams.push(`%${search}%`);
            paramCounter++;
        }

        queryText += ` ORDER BY c.due_date ASC LIMIT $${paramCounter}`;
        queryParams.push(Number(limit));

        const result = await pool.query(queryText, queryParams);

        return res.json({ success: true, data: result.rows });
    } catch (e) {
        console.error("Error fetching checks:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* GET ONE CHECK */
router.get("/:id", authMiddleware, async (req, res) => {
    try {
        const id = req.params.id;
        const member_id = req.user.member_id;

        const query = `
            SELECT * FROM public.treasury_checks 
            WHERE id = $1 AND member_id = $2
        `;

        const result = await pool.query(query, [id, member_id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "چک یافت نشد" });
        }

        return res.json({ success: true, data: result.rows[0] });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* CREATE CHECK (صدور چک) */
router.post("/", authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.member_id;
        const body = req.body;

        const payload = { ...body, member_id };
        delete payload.id;
        delete payload.created_at;

        // چک تکراری بودن شماره چک در آن دسته‌چک
        if (payload.checkbook_id && payload.check_number) {
            const checkExist = await pool.query(
                `SELECT id FROM public.treasury_checks WHERE checkbook_id = $1 AND check_number = $2`,
                [payload.checkbook_id, payload.check_number]
            );
            if (checkExist.rows.length > 0) {
                return res.status(409).json({ success: false, error: "این شماره چک قبلاً ثبت شده است" });
            }
        }

        const keys = Object.keys(payload);
        const values = Object.values(payload);
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
        const columns = keys.join(", ");

        const query = `
            INSERT INTO public.treasury_checks (${columns}) 
            VALUES (${placeholders}) 
            RETURNING *
        `;

        const result = await pool.query(query, values);

        return res.json({
            success: true,
            data: result.rows[0],
            message: "چک با موفقیت ثبت شد"
        });

    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* UPDATE CHECK (ویرایش چک) */
router.put("/:id", authMiddleware, async (req, res) => {
    try {
        const id = req.params.id;
        const member_id = req.user.member_id;
        const payload = { ...req.body };

        delete payload.id;
        delete payload.member_id;
        delete payload.created_at;

        const keys = Object.keys(payload);
        if (keys.length === 0) return res.status(400).json({ error: "No data" });

        const setClause = keys.map((key, index) => `${key} = $${index + 1}`).join(", ");
        const values = Object.values(payload);
        values.push(id);
        values.push(member_id);

        const query = `
            UPDATE public.treasury_checks 
            SET ${setClause} 
            WHERE id = $${values.length - 1} AND member_id = $${values.length} 
            RETURNING *
        `;

        const result = await pool.query(query, values);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "چک یافت نشد" });
        }

        return res.json({ success: true, data: result.rows[0], message: "ویرایش شد" });

    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* DELETE CHECK */
router.delete("/:id", authMiddleware, async (req, res) => {
    try {
        const id = req.params.id;
        const member_id = req.user.member_id;

        // فقط چک‌های پاس نشده (pending) قابل حذف هستند
        const checkStatus = await pool.query(
            `SELECT status FROM public.treasury_checks WHERE id = $1 AND member_id = $2`,
            [id, member_id]
        );

        if (checkStatus.rows.length > 0 && checkStatus.rows[0].status !== 'pending') {
            return res.status(400).json({
                success: false,
                error: "فقط چک‌های در جریان وصول قابل حذف هستند. برای بقیه باید وضعیت را تغییر دهید."
            });
        }

        const query = `DELETE FROM public.treasury_checks WHERE id = $1 AND member_id = $2`;
        await pool.query(query, [id, member_id]);

        return res.json({ success: true, message: "چک حذف شد" });

    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;