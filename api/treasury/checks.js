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
                    'bank_id', cb.bank_id,
                    'bank_name', b.bank_name
                ) as checkbook,
                json_build_object(
                    'id', tb.id,
                    'bank_name', tb.bank_name,
                    'account_no', tb.account_no
                ) as target_bank
            FROM public.treasury_checks c
            LEFT JOIN public.treasury_checkbooks cb ON c.checkbook_id = cb.id
            LEFT JOIN public.treasury_banks b ON cb.bank_id = b.id
            LEFT JOIN public.treasury_banks tb ON c.target_bank_id = tb.id
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
            queryText += ` AND (c.cheque_no ILIKE $${paramCounter} OR c.sayadi_code ILIKE $${paramCounter})`;
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
        if (payload.checkbook_id && payload.cheque_no) {
            const checkExist = await pool.query(
                `SELECT id FROM public.treasury_checks WHERE checkbook_id = $1 AND cheque_no = $2`,
                [payload.checkbook_id, payload.cheque_no]
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

/* ================================================================
   POST /api/treasury-checks/:id/pass
   پاس شدن چک - ثبت سند حسابداری خودکار
   
   چک دریافتنی پاس شود: بدهکار بانک / بستانکار اسناد دریافتنی
   چک پرداختنی پاس شود: بدهکار اسناد پرداختنی / بستانکار بانک
================================================================ */
router.post("/:id/pass", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const id = req.params.id;
        const member_id = req.user.member_id;
        const { bank_id: explicitBankId, pass_date, description } = req.body;

        const checkRes = await client.query(
            "SELECT * FROM public.treasury_checks WHERE id = $1 AND member_id = $2",
            [id, member_id]
        );
        if (checkRes.rows.length === 0) {
            return res.status(404).json({ success: false, error: "چک یافت نشد" });
        }
        const cheque = checkRes.rows[0];

        if (cheque.status === 'passed' || cheque.status === 'cashed') {
            return res.status(400).json({ success: false, error: "این چک قبلاً پاس شده است" });
        }

        let bank_id = explicitBankId || cheque.target_bank_id;

        if (!bank_id && cheque.checkbook_id) {
            const cbRes = await client.query(
                "SELECT bank_id FROM public.treasury_checkbooks WHERE id = $1",
                [cheque.checkbook_id]
            );
            if (cbRes.rows.length > 0) bank_id = cbRes.rows[0].bank_id;
        }

        if (!bank_id) {
            return res.status(400).json({ success: false, error: "حساب بانک مشخص نیست. لطفا بانک را انتخاب کنید." });
        }

        const bankRes = await client.query(
            "SELECT id, bank_name, tafsili_id FROM public.treasury_banks WHERE id = $1 AND member_id = $2",
            [bank_id, member_id]
        );
        if (bankRes.rows.length === 0) {
            return res.status(404).json({ success: false, error: "حساب بانک یافت نشد" });
        }
        const bank = bankRes.rows[0];

        await client.query('BEGIN');

        const fmtAmt = (n) => Number(n).toLocaleString('fa-IR');
        const amount = Number(cheque.amount);
        const chequeInfo = `چک شماره ${cheque.cheque_no || ''}`;
        const bankInfo = `بانک ${bank.bank_name}`;
        const passDateVal = pass_date || new Date().toISOString().slice(0, 10);

        const maxRes = await client.query(
            'SELECT MAX(doc_no::INTEGER) as max_no FROM public.financial_documents WHERE member_id = $1',
            [member_id]
        );
        const docNo = ((maxRes.rows[0].max_no || 1000) + 1).toString();

        const findMoein = async (code) => {
            const r = await client.query('SELECT id FROM public.accounting_moein WHERE code = $1 LIMIT 1', [code]);
            return r.rows.length > 0 ? r.rows[0].id : null;
        };

        let docDesc, debitMoeinId, creditMoeinId, debitTafsili, creditTafsili, debitDesc, creditDesc;

        if (cheque.type === 'receivable') {
            docDesc = `وصول ${chequeInfo} - واریز به ${bankInfo} - مبلغ ${fmtAmt(amount)} ریال`;
            debitMoeinId = await findMoein("10103");
            debitTafsili = bank.tafsili_id;
            debitDesc = `واریز وجه ${chequeInfo} به حساب ${bankInfo} - مبلغ ${fmtAmt(amount)} ریال`;
            creditMoeinId = await findMoein("10302");
            creditTafsili = null;
            creditDesc = `وصول ${chequeInfo} - مبلغ ${fmtAmt(amount)} ریال - واریز به ${bankInfo}`;
        } else {
            docDesc = `پاس شدن ${chequeInfo} - برداشت از ${bankInfo} - مبلغ ${fmtAmt(amount)} ریال`;
            debitMoeinId = await findMoein("30102");
            debitTafsili = null;
            debitDesc = `تسویه ${chequeInfo} - مبلغ ${fmtAmt(amount)} ریال`;
            creditMoeinId = await findMoein("10103");
            creditTafsili = bank.tafsili_id;
            creditDesc = `برداشت از ${bankInfo} بابت پاس شدن ${chequeInfo} - مبلغ ${fmtAmt(amount)} ریال`;
        }

        if (!debitMoeinId || !creditMoeinId) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: "سرفصل‌های حسابداری مورد نیاز تعریف نشده‌اند" });
        }

        const docResult = await client.query(`
            INSERT INTO public.financial_documents 
            (member_id, doc_no, doc_date, description, status, doc_type)
            VALUES ($1, $2, $3, $4, 'confirmed', 'cheque_pass')
            RETURNING id
        `, [member_id, docNo, passDateVal, docDesc]);
        const docId = docResult.rows[0].id;

        await client.query(`
            INSERT INTO public.financial_entries 
            (doc_id, member_id, moein_id, tafsili_id, bed, bes, description)
            VALUES ($1, $2, $3, $4, $5, 0, $6)
        `, [docId, member_id, debitMoeinId, debitTafsili, amount, debitDesc]);

        await client.query(`
            INSERT INTO public.financial_entries 
            (doc_id, member_id, moein_id, tafsili_id, bed, bes, description)
            VALUES ($1, $2, $3, $4, 0, $5, $6)
        `, [docId, member_id, creditMoeinId, creditTafsili, amount, creditDesc]);

        await client.query(
            "UPDATE public.treasury_checks SET status = 'passed', target_bank_id = $3, description = COALESCE($4, description) WHERE id = $1 AND member_id = $2",
            [id, member_id, bank_id, description || null]
        );

        await client.query('COMMIT');

        return res.json({
            success: true,
            data: { doc_id: docId, doc_no: docNo, cheque_id: id },
            message: `${chequeInfo} با موفقیت پاس شد - سند شماره ${docNo} ثبت شد`
        });

    } catch (e) {
        await client.query('ROLLBACK');
        console.error("❌ Cheque Pass Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

/* ================================================================
   POST /api/treasury-checks/:id/bounce
   برگشت چک - ثبت سند حسابداری خودکار
   
   چک دریافتنی برگشت بخورد: بدهکار طرف حساب / بستانکار اسناد دریافتنی
   چک پرداختنی برگشت بخورد: بدهکار اسناد پرداختنی / بستانکار طرف حساب
================================================================ */
router.post("/:id/bounce", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const id = req.params.id;
        const member_id = req.user.member_id;
        const { bounce_date, description } = req.body;

        const checkRes = await client.query(
            "SELECT * FROM public.treasury_checks WHERE id = $1 AND member_id = $2",
            [id, member_id]
        );
        if (checkRes.rows.length === 0) {
            return res.status(404).json({ success: false, error: "چک یافت نشد" });
        }
        const cheque = checkRes.rows[0];

        if (cheque.status === 'bounced') {
            return res.status(400).json({ success: false, error: "این چک قبلاً برگشت خورده است" });
        }

        await client.query('BEGIN');

        const fmtAmt = (n) => Number(n).toLocaleString('fa-IR');
        const amount = Number(cheque.amount);
        const chequeInfo = `چک شماره ${cheque.cheque_no || ''}`;
        const bounceDateVal = bounce_date || new Date().toISOString().slice(0, 10);

        const maxRes = await client.query(
            'SELECT MAX(doc_no::INTEGER) as max_no FROM public.financial_documents WHERE member_id = $1',
            [member_id]
        );
        const docNo = ((maxRes.rows[0].max_no || 1000) + 1).toString();

        const findMoein = async (code) => {
            const r = await client.query('SELECT id FROM public.accounting_moein WHERE code = $1 LIMIT 1', [code]);
            return r.rows.length > 0 ? r.rows[0].id : null;
        };

        let docDesc, debitMoeinId, creditMoeinId, debitTafsili, creditTafsili, debitDesc, creditDesc;

        if (cheque.type === 'receivable') {
            const personId = cheque.owner_id;
            let personTitle = 'صادرکننده';
            if (personId) {
                const pr = await client.query('SELECT title FROM public.accounting_tafsili WHERE id = $1', [personId]);
                if (pr.rows.length > 0) personTitle = pr.rows[0].title;
            }

            docDesc = `برگشت ${chequeInfo} - بدهکار: ${personTitle} - مبلغ ${fmtAmt(amount)} ریال`;
            debitMoeinId = await findMoein("10301");
            debitTafsili = personId;
            debitDesc = `${personTitle} بابت برگشت ${chequeInfo} - مبلغ ${fmtAmt(amount)} ریال`;
            creditMoeinId = await findMoein("10302");
            creditTafsili = null;
            creditDesc = `برگشت ${chequeInfo} از ${personTitle} - مبلغ ${fmtAmt(amount)} ریال`;
        } else {
            const personId = cheque.receiver_id;
            let personTitle = 'دریافت‌کننده';
            if (personId) {
                const pr = await client.query('SELECT title FROM public.accounting_tafsili WHERE id = $1', [personId]);
                if (pr.rows.length > 0) personTitle = pr.rows[0].title;
            }

            docDesc = `برگشت ${chequeInfo} پرداختنی - بستانکار: ${personTitle} - مبلغ ${fmtAmt(amount)} ریال`;
            debitMoeinId = await findMoein("30102");
            debitTafsili = null;
            debitDesc = `تسویه ${chequeInfo} پرداختنی (برگشتی) - مبلغ ${fmtAmt(amount)} ریال`;
            creditMoeinId = await findMoein("10301");
            creditTafsili = personId;
            creditDesc = `${personTitle} بابت برگشت ${chequeInfo} پرداختنی - مبلغ ${fmtAmt(amount)} ریال`;
        }

        if (!debitMoeinId || !creditMoeinId) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: "سرفصل‌های حسابداری مورد نیاز تعریف نشده‌اند" });
        }

        const docResult = await client.query(`
            INSERT INTO public.financial_documents 
            (member_id, doc_no, doc_date, description, status, doc_type)
            VALUES ($1, $2, $3, $4, 'confirmed', 'cheque_bounce')
            RETURNING id
        `, [member_id, docNo, bounceDateVal, docDesc]);
        const docId = docResult.rows[0].id;

        await client.query(`
            INSERT INTO public.financial_entries 
            (doc_id, member_id, moein_id, tafsili_id, bed, bes, description)
            VALUES ($1, $2, $3, $4, $5, 0, $6)
        `, [docId, member_id, debitMoeinId, debitTafsili, amount, debitDesc]);

        await client.query(`
            INSERT INTO public.financial_entries 
            (doc_id, member_id, moein_id, tafsili_id, bed, bes, description)
            VALUES ($1, $2, $3, $4, 0, $5, $6)
        `, [docId, member_id, creditMoeinId, creditTafsili, amount, creditDesc]);

        await client.query(
            "UPDATE public.treasury_checks SET status = 'bounced', description = COALESCE($3, description) WHERE id = $1 AND member_id = $2",
            [id, member_id, description || null]
        );

        await client.query('COMMIT');

        return res.json({
            success: true,
            data: { doc_id: docId, doc_no: docNo, cheque_id: id },
            message: `${chequeInfo} برگشت خورد - سند شماره ${docNo} ثبت شد`
        });

    } catch (e) {
        await client.query('ROLLBACK');
        console.error("❌ Cheque Bounce Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

/* ================================================================
   POST /api/treasury-checks/:id/cancel
   ابطال چک (فقط چک‌های صادره خودمان)
================================================================ */
router.post("/:id/cancel", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const id = req.params.id;
        const member_id = req.user.member_id;
        const { cancel_date, description } = req.body;

        const checkRes = await client.query(
            "SELECT * FROM public.treasury_checks WHERE id = $1 AND member_id = $2",
            [id, member_id]
        );
        if (checkRes.rows.length === 0) {
            return res.status(404).json({ success: false, error: "چک یافت نشد" });
        }
        const cheque = checkRes.rows[0];

        if (cheque.status === 'passed' || cheque.status === 'cashed') {
            return res.status(400).json({ success: false, error: "چک پاس شده قابل ابطال نیست" });
        }

        await client.query('BEGIN');

        const fmtAmt = (n) => Number(n).toLocaleString('fa-IR');
        const amount = Number(cheque.amount);
        const chequeInfo = `چک شماره ${cheque.cheque_no || ''}`;
        const cancelDateVal = cancel_date || new Date().toISOString().slice(0, 10);

        const maxRes = await client.query(
            'SELECT MAX(doc_no::INTEGER) as max_no FROM public.financial_documents WHERE member_id = $1',
            [member_id]
        );
        const docNo = ((maxRes.rows[0].max_no || 1000) + 1).toString();

        const findMoein = async (code) => {
            const r = await client.query('SELECT id FROM public.accounting_moein WHERE code = $1 LIMIT 1', [code]);
            return r.rows.length > 0 ? r.rows[0].id : null;
        };

        let docDesc, debitMoeinId, creditMoeinId, debitTafsili, creditTafsili, debitDesc, creditDesc;

        if (cheque.type === 'payable') {
            const personId = cheque.receiver_id;
            let personTitle = 'دریافت‌کننده';
            if (personId) {
                const pr = await client.query('SELECT title FROM public.accounting_tafsili WHERE id = $1', [personId]);
                if (pr.rows.length > 0) personTitle = pr.rows[0].title;
            }

            docDesc = `ابطال ${chequeInfo} پرداختنی - مبلغ ${fmtAmt(amount)} ریال`;
            debitMoeinId = await findMoein("30102");
            debitTafsili = null;
            debitDesc = `ابطال ${chequeInfo} - مبلغ ${fmtAmt(amount)} ریال`;
            creditMoeinId = await findMoein("10301");
            creditTafsili = personId;
            creditDesc = `${personTitle} بابت ابطال ${chequeInfo} - مبلغ ${fmtAmt(amount)} ریال`;
        } else {
            const personId = cheque.owner_id;
            let personTitle = 'صادرکننده';
            if (personId) {
                const pr = await client.query('SELECT title FROM public.accounting_tafsili WHERE id = $1', [personId]);
                if (pr.rows.length > 0) personTitle = pr.rows[0].title;
            }

            docDesc = `ابطال/عودت ${chequeInfo} دریافتنی - مبلغ ${fmtAmt(amount)} ریال`;
            debitMoeinId = await findMoein("10301");
            debitTafsili = personId;
            debitDesc = `${personTitle} بابت عودت ${chequeInfo} - مبلغ ${fmtAmt(amount)} ریال`;
            creditMoeinId = await findMoein("10302");
            creditTafsili = null;
            creditDesc = `عودت ${chequeInfo} دریافتنی - مبلغ ${fmtAmt(amount)} ریال`;
        }

        if (!debitMoeinId || !creditMoeinId) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: "سرفصل‌های حسابداری مورد نیاز تعریف نشده‌اند" });
        }

        const docResult = await client.query(`
            INSERT INTO public.financial_documents 
            (member_id, doc_no, doc_date, description, status, doc_type)
            VALUES ($1, $2, $3, $4, 'confirmed', 'cheque_cancel')
            RETURNING id
        `, [member_id, docNo, cancelDateVal, docDesc]);
        const docId = docResult.rows[0].id;

        await client.query(`
            INSERT INTO public.financial_entries 
            (doc_id, member_id, moein_id, tafsili_id, bed, bes, description)
            VALUES ($1, $2, $3, $4, $5, 0, $6)
        `, [docId, member_id, debitMoeinId, debitTafsili, amount, debitDesc]);

        await client.query(`
            INSERT INTO public.financial_entries 
            (doc_id, member_id, moein_id, tafsili_id, bed, bes, description)
            VALUES ($1, $2, $3, $4, 0, $5, $6)
        `, [docId, member_id, creditMoeinId, creditTafsili, amount, creditDesc]);

        await client.query(
            "UPDATE public.treasury_checks SET status = 'cancelled', description = COALESCE($3, description) WHERE id = $1 AND member_id = $2",
            [id, member_id, description || null]
        );

        await client.query('COMMIT');

        return res.json({
            success: true,
            data: { doc_id: docId, doc_no: docNo, cheque_id: id },
            message: `${chequeInfo} ابطال شد - سند شماره ${docNo} ثبت شد`
        });

    } catch (e) {
        await client.query('ROLLBACK');
        console.error("❌ Cheque Cancel Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
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