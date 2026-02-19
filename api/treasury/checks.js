const express = require("express");
const { pool } = require("../../supabaseAdmin");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

const fmtAmt = (n) => Number(n).toLocaleString('fa-IR');

const findMoein = async (client, code) => {
    const r = await client.query('SELECT id FROM public.accounting_moein WHERE code = $1 LIMIT 1', [code]);
    return r.rows.length > 0 ? r.rows[0].id : null;
};

const genDocNo = async (client, member_id) => {
    const r = await client.query('SELECT MAX(doc_no::INTEGER) as mx FROM public.financial_documents WHERE member_id = $1', [member_id]);
    return ((r.rows[0].mx || 1000) + 1).toString();
};

const getPersonTitle = async (client, personId) => {
    if (!personId) return 'نامشخص';
    const r = await client.query('SELECT title FROM public.accounting_tafsili WHERE id = $1', [personId]);
    return r.rows.length > 0 ? r.rows[0].title : 'نامشخص';
};

const createDocWithEntries = async (client, member_id, docNo, docDate, docDesc, docType, entries) => {
    const docRes = await client.query(`
        INSERT INTO public.financial_documents (member_id, doc_no, doc_date, description, status, doc_type)
        VALUES ($1, $2, $3, $4, 'confirmed', $5) RETURNING id
    `, [member_id, docNo, docDate, docDesc, docType]);
    const docId = docRes.rows[0].id;
    for (const e of entries) {
        await client.query(`
            INSERT INTO public.financial_entries (doc_id, member_id, moein_id, tafsili_id, bed, bes, description)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [docId, member_id, e.moein_id, e.tafsili_id, e.bed || 0, e.bes || 0, e.description]);
    }
    return docId;
};

/* ============================================================ */
/* GET ALL CHECKS                                                */
/* ============================================================ */
router.get("/", authMiddleware, async (req, res) => {
    try {
        const { status, type, limit = 100, search, checkbook_id } = req.query;
        const member_id = req.user.member_id;

        let q = `
            SELECT c.*,
                json_build_object('id', cb.id, 'serial_start', cb.serial_start, 'serial_end', cb.serial_end, 'bank_id', cb.bank_id, 'bank_name', b.bank_name) as checkbook,
                json_build_object('id', tb.id, 'bank_name', tb.bank_name, 'account_no', tb.account_no, 'tafsili_id', tb.tafsili_id) as target_bank,
                (SELECT title FROM public.accounting_tafsili WHERE id = c.owner_id LIMIT 1) as owner_title,
                (SELECT title FROM public.accounting_tafsili WHERE id = c.receiver_id LIMIT 1) as receiver_title
            FROM public.treasury_checks c
            LEFT JOIN public.treasury_checkbooks cb ON c.checkbook_id = cb.id
            LEFT JOIN public.treasury_banks b ON cb.bank_id = b.id
            LEFT JOIN public.treasury_banks tb ON c.target_bank_id = tb.id
            WHERE c.member_id = $1
        `;
        const p = [member_id];
        let idx = 2;

        if (status) { q += ` AND c.status = $${idx}`; p.push(status); idx++; }
        if (type) { q += ` AND c.type = $${idx}`; p.push(type); idx++; }
        if (checkbook_id) { q += ` AND c.checkbook_id = $${idx}`; p.push(checkbook_id); idx++; }
        if (search) { q += ` AND (c.cheque_no ILIKE $${idx} OR c.sayadi_code ILIKE $${idx})`; p.push(`%${search}%`); idx++; }

        q += ` ORDER BY c.created_at DESC LIMIT $${idx}`;
        p.push(Number(limit));

        const result = await pool.query(q, p);
        return res.json({ success: true, data: result.rows });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* GET ONE CHECK */
router.get("/:id", authMiddleware, async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM public.treasury_checks WHERE id = $1 AND member_id = $2", [req.params.id, req.user.member_id]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, error: "چک یافت نشد" });
        return res.json({ success: true, data: result.rows[0] });
    } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

/* CREATE CHECK */
router.post("/", authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.member_id;
        const payload = { ...req.body, member_id };
        delete payload.id; delete payload.created_at;
        if (payload.checkbook_id && payload.cheque_no) {
            const ex = await pool.query("SELECT id FROM public.treasury_checks WHERE checkbook_id = $1 AND cheque_no = $2", [payload.checkbook_id, payload.cheque_no]);
            if (ex.rows.length > 0) return res.status(409).json({ success: false, error: "این شماره چک قبلاً ثبت شده" });
        }
        const keys = Object.keys(payload), vals = Object.values(payload);
        const result = await pool.query(`INSERT INTO public.treasury_checks (${keys.join(",")}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(",")}) RETURNING *`, vals);
        return res.json({ success: true, data: result.rows[0], message: "چک ثبت شد" });
    } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

/* UPDATE CHECK */
router.put("/:id", authMiddleware, async (req, res) => {
    try {
        const payload = { ...req.body }; delete payload.id; delete payload.member_id; delete payload.created_at;
        const keys = Object.keys(payload);
        if (keys.length === 0) return res.status(400).json({ error: "No data" });
        const vals = [...Object.values(payload), req.params.id, req.user.member_id];
        const result = await pool.query(`UPDATE public.treasury_checks SET ${keys.map((k,i)=>`${k}=$${i+1}`).join(",")} WHERE id=$${vals.length-1} AND member_id=$${vals.length} RETURNING *`, vals);
        if (result.rows.length === 0) return res.status(404).json({ success: false, error: "چک یافت نشد" });
        return res.json({ success: true, data: result.rows[0], message: "ویرایش شد" });
    } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

/* ================================================================
   چک دریافتنی: خرج کردن (spend)
   pending → spent
   سند: بدهکار شخص جدید (10301) / بستانکار اسناد دریافتنی (10302)
================================================================ */
router.post("/:id/spend", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        const member_id = req.user.member_id;
        const { person_id, op_date, description } = req.body;

        if (!person_id) return res.status(400).json({ success: false, error: "انتخاب شخص گیرنده الزامی است" });

        const chk = await client.query("SELECT * FROM public.treasury_checks WHERE id=$1 AND member_id=$2", [id, member_id]);
        if (chk.rows.length === 0) return res.status(404).json({ success: false, error: "چک یافت نشد" });
        const cheque = chk.rows[0];
        if (cheque.status !== 'pending') return res.status(400).json({ success: false, error: "فقط چک‌های نزد صندوق قابل خرج هستند" });

        await client.query('BEGIN');
        const amount = Number(cheque.amount);
        const chequeInfo = `چک شماره ${cheque.cheque_no || ''}`;
        const personTitle = await getPersonTitle(client, person_id);
        const dateVal = op_date || new Date().toISOString().slice(0,10);
        const docNo = await genDocNo(client, member_id);

        const debitMoeinId = await findMoein(client, "10301");
        const creditMoeinId = await findMoein(client, "10302");
        if (!debitMoeinId || !creditMoeinId) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, error: "سرفصل‌ها تعریف نشده" }); }

        const docDesc = `خرج ${chequeInfo} به ${personTitle} - مبلغ ${fmtAmt(amount)} ریال`;
        const docId = await createDocWithEntries(client, member_id, docNo, dateVal, docDesc, 'cheque_spend', [
            { moein_id: debitMoeinId, tafsili_id: person_id, bed: amount, bes: 0, description: `${personTitle} بابت دریافت ${chequeInfo} - ${fmtAmt(amount)} ریال` },
            { moein_id: creditMoeinId, tafsili_id: null, bed: 0, bes: amount, description: `خرج ${chequeInfo} به ${personTitle} - ${fmtAmt(amount)} ریال` }
        ]);

        await client.query("UPDATE public.treasury_checks SET status='spent', receiver_id=$3, description=COALESCE($4, description) WHERE id=$1 AND member_id=$2",
            [id, member_id, person_id, description || `خرج به ${personTitle}`]);

        await client.query('COMMIT');
        return res.json({ success: true, data: { doc_id: docId, doc_no: docNo }, message: `${chequeInfo} خرج شد - سند ${docNo}` });
    } catch (e) { await client.query('ROLLBACK'); return res.status(500).json({ success: false, error: e.message }); }
    finally { client.release(); }
});

/* ================================================================
   چک دریافتنی: خواباندن به حساب بانکی (deposit)
   pending → deposited
   بدون سند حسابداری - فقط تغییر وضعیت
   اسناد در جریان وصول: بدهکار (10303) / بستانکار اسناد دریافتنی (10302)
================================================================ */
router.post("/:id/deposit", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        const member_id = req.user.member_id;
        const { bank_id, op_date, description } = req.body;

        if (!bank_id) return res.status(400).json({ success: false, error: "انتخاب حساب بانک الزامی است" });

        const chk = await client.query("SELECT * FROM public.treasury_checks WHERE id=$1 AND member_id=$2", [id, member_id]);
        if (chk.rows.length === 0) return res.status(404).json({ success: false, error: "چک یافت نشد" });
        const cheque = chk.rows[0];
        if (cheque.status !== 'pending') return res.status(400).json({ success: false, error: "فقط چک‌های نزد صندوق قابل خواباندن هستند" });

        const bankRes = await client.query("SELECT id, bank_name, tafsili_id FROM public.treasury_banks WHERE id=$1 AND member_id=$2", [bank_id, member_id]);
        if (bankRes.rows.length === 0) return res.status(404).json({ success: false, error: "حساب بانک یافت نشد" });
        const bank = bankRes.rows[0];

        await client.query('BEGIN');
        const amount = Number(cheque.amount);
        const chequeInfo = `چک شماره ${cheque.cheque_no || ''}`;
        const dateVal = op_date || new Date().toISOString().slice(0,10);
        const docNo = await genDocNo(client, member_id);

        const debitMoeinId = await findMoein(client, "10303");
        const creditMoeinId = await findMoein(client, "10302");
        if (!debitMoeinId || !creditMoeinId) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, error: "سرفصل‌ها تعریف نشده" }); }

        const docDesc = `واگذاری ${chequeInfo} به بانک ${bank.bank_name} جهت وصول - مبلغ ${fmtAmt(amount)} ریال`;
        const docId = await createDocWithEntries(client, member_id, docNo, dateVal, docDesc, 'cheque_deposit', [
            { moein_id: debitMoeinId, tafsili_id: null, bed: amount, bes: 0, description: `${chequeInfo} در جریان وصول - بانک ${bank.bank_name} - ${fmtAmt(amount)} ریال` },
            { moein_id: creditMoeinId, tafsili_id: null, bed: 0, bes: amount, description: `واگذاری ${chequeInfo} به بانک ${bank.bank_name} - ${fmtAmt(amount)} ریال` }
        ]);

        await client.query("UPDATE public.treasury_checks SET status='deposited', target_bank_id=$3, description=COALESCE($4, description) WHERE id=$1 AND member_id=$2",
            [id, member_id, bank_id, description || `واگذاری به ${bank.bank_name}`]);

        await client.query('COMMIT');
        return res.json({ success: true, data: { doc_id: docId, doc_no: docNo }, message: `${chequeInfo} به ${bank.bank_name} واگذار شد - سند ${docNo}` });
    } catch (e) { await client.query('ROLLBACK'); return res.status(500).json({ success: false, error: e.message }); }
    finally { client.release(); }
});

/* ================================================================
   چک دریافتنی: واریز نقدی به صندوق (cash-deposit)
   pending → passed
   سند: بدهکار صندوق (10101) / بستانکار اسناد دریافتنی (10302)
================================================================ */
router.post("/:id/cash-deposit", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        const member_id = req.user.member_id;
        const { cash_id, op_date, description } = req.body;

        if (!cash_id) return res.status(400).json({ success: false, error: "انتخاب صندوق الزامی است" });

        const chk = await client.query("SELECT * FROM public.treasury_checks WHERE id=$1 AND member_id=$2", [id, member_id]);
        if (chk.rows.length === 0) return res.status(404).json({ success: false, error: "چک یافت نشد" });
        const cheque = chk.rows[0];
        if (cheque.status !== 'pending') return res.status(400).json({ success: false, error: "فقط چک‌های نزد صندوق قابل واریز هستند" });

        const cashRes = await client.query("SELECT id, title, tafsili_id FROM public.treasury_cashes WHERE id=$1 AND member_id=$2", [cash_id, member_id]);
        if (cashRes.rows.length === 0) return res.status(404).json({ success: false, error: "صندوق یافت نشد" });
        const cash = cashRes.rows[0];

        await client.query('BEGIN');
        const amount = Number(cheque.amount);
        const chequeInfo = `چک شماره ${cheque.cheque_no || ''}`;
        const dateVal = op_date || new Date().toISOString().slice(0,10);
        const docNo = await genDocNo(client, member_id);

        const debitMoeinId = await findMoein(client, "10101");
        const creditMoeinId = await findMoein(client, "10302");
        if (!debitMoeinId || !creditMoeinId) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, error: "سرفصل‌ها تعریف نشده" }); }

        const docDesc = `وصول نقدی ${chequeInfo} - واریز به صندوق ${cash.title} - مبلغ ${fmtAmt(amount)} ریال`;
        const docId = await createDocWithEntries(client, member_id, docNo, dateVal, docDesc, 'cheque_pass', [
            { moein_id: debitMoeinId, tafsili_id: cash.tafsili_id, bed: amount, bes: 0, description: `واریز وجه ${chequeInfo} به صندوق ${cash.title} - ${fmtAmt(amount)} ریال` },
            { moein_id: creditMoeinId, tafsili_id: null, bed: 0, bes: amount, description: `وصول نقدی ${chequeInfo} - ${fmtAmt(amount)} ریال` }
        ]);

        await client.query("UPDATE public.treasury_checks SET status='passed', description=COALESCE($3, description) WHERE id=$1 AND member_id=$2",
            [id, member_id, description || `وصول نقدی - صندوق ${cash.title}`]);

        await client.query('COMMIT');
        return res.json({ success: true, data: { doc_id: docId, doc_no: docNo }, message: `${chequeInfo} وصول و به صندوق واریز شد - سند ${docNo}` });
    } catch (e) { await client.query('ROLLBACK'); return res.status(500).json({ success: false, error: e.message }); }
    finally { client.release(); }
});

/* ================================================================
   چک دریافتنی: برگشت به طرف حساب (return)
   pending → returned
   سند: بدهکار طرف حساب (10301) / بستانکار اسناد دریافتنی (10302)
================================================================ */
router.post("/:id/return", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        const member_id = req.user.member_id;
        const { op_date, description } = req.body;

        const chk = await client.query("SELECT * FROM public.treasury_checks WHERE id=$1 AND member_id=$2", [id, member_id]);
        if (chk.rows.length === 0) return res.status(404).json({ success: false, error: "چک یافت نشد" });
        const cheque = chk.rows[0];
        if (cheque.status !== 'pending') return res.status(400).json({ success: false, error: "فقط چک‌های نزد صندوق قابل عودت هستند" });

        await client.query('BEGIN');
        const amount = Number(cheque.amount);
        const chequeInfo = `چک شماره ${cheque.cheque_no || ''}`;
        const personTitle = await getPersonTitle(client, cheque.owner_id);
        const dateVal = op_date || new Date().toISOString().slice(0,10);
        const docNo = await genDocNo(client, member_id);

        const debitMoeinId = await findMoein(client, "10301");
        const creditMoeinId = await findMoein(client, "10302");
        if (!debitMoeinId || !creditMoeinId) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, error: "سرفصل‌ها تعریف نشده" }); }

        const docDesc = `عودت ${chequeInfo} به ${personTitle} - مبلغ ${fmtAmt(amount)} ریال`;
        const docId = await createDocWithEntries(client, member_id, docNo, dateVal, docDesc, 'cheque_return', [
            { moein_id: debitMoeinId, tafsili_id: cheque.owner_id, bed: amount, bes: 0, description: `${personTitle} بابت عودت ${chequeInfo} - ${fmtAmt(amount)} ریال` },
            { moein_id: creditMoeinId, tafsili_id: null, bed: 0, bes: amount, description: `عودت ${chequeInfo} به ${personTitle} - ${fmtAmt(amount)} ریال` }
        ]);

        await client.query("UPDATE public.treasury_checks SET status='returned', description=COALESCE($3, description) WHERE id=$1 AND member_id=$2",
            [id, member_id, description || `عودت به ${personTitle}`]);

        await client.query('COMMIT');
        return res.json({ success: true, data: { doc_id: docId, doc_no: docNo }, message: `${chequeInfo} به ${personTitle} عودت شد - سند ${docNo}` });
    } catch (e) { await client.query('ROLLBACK'); return res.status(500).json({ success: false, error: e.message }); }
    finally { client.release(); }
});

/* ================================================================
   چک واگذاری: پاس شدن (pass) - برای deposited
   deposited → passed
   سند: بدهکار بانک (10103) / بستانکار اسناد در جریان وصول (10303)
   
   چک پرداختنی: پاس شدن
   issued → passed
   سند: بدهکار اسناد پرداختنی (30102) / بستانکار بانک (10103)
================================================================ */
router.post("/:id/pass", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        const member_id = req.user.member_id;
        const { bank_id: explicitBankId, pass_date, description } = req.body;

        const chk = await client.query("SELECT * FROM public.treasury_checks WHERE id=$1 AND member_id=$2", [id, member_id]);
        if (chk.rows.length === 0) return res.status(404).json({ success: false, error: "چک یافت نشد" });
        const cheque = chk.rows[0];

        if (cheque.status === 'passed') return res.status(400).json({ success: false, error: "قبلاً پاس شده" });

        let bank_id = explicitBankId || cheque.target_bank_id;
        if (!bank_id && cheque.checkbook_id) {
            const cb = await client.query("SELECT bank_id FROM public.treasury_checkbooks WHERE id=$1", [cheque.checkbook_id]);
            if (cb.rows.length > 0) bank_id = cb.rows[0].bank_id;
        }
        if (!bank_id) return res.status(400).json({ success: false, error: "حساب بانک مشخص نیست" });

        const bankRes = await client.query("SELECT id, bank_name, tafsili_id FROM public.treasury_banks WHERE id=$1 AND member_id=$2", [bank_id, member_id]);
        if (bankRes.rows.length === 0) return res.status(404).json({ success: false, error: "بانک یافت نشد" });
        const bank = bankRes.rows[0];

        await client.query('BEGIN');
        const amount = Number(cheque.amount);
        const chequeInfo = `چک شماره ${cheque.cheque_no || ''}`;
        const dateVal = pass_date || new Date().toISOString().slice(0,10);
        const docNo = await genDocNo(client, member_id);

        let entries, docDesc;

        if (cheque.type === 'receivable') {
            const debitMoeinId = await findMoein(client, "10103");
            const creditMoeinId = await findMoein(client, "10303");
            if (!debitMoeinId || !creditMoeinId) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, error: "سرفصل‌ها تعریف نشده" }); }
            docDesc = `وصول ${chequeInfo} - واریز به بانک ${bank.bank_name} - ${fmtAmt(amount)} ریال`;
            entries = [
                { moein_id: debitMoeinId, tafsili_id: bank.tafsili_id, bed: amount, bes: 0, description: `واریز ${chequeInfo} به ${bank.bank_name} - ${fmtAmt(amount)} ریال` },
                { moein_id: creditMoeinId, tafsili_id: null, bed: 0, bes: amount, description: `وصول ${chequeInfo} از حساب در جریان وصول - ${fmtAmt(amount)} ریال` }
            ];
        } else {
            const debitMoeinId = await findMoein(client, "30102");
            const creditMoeinId = await findMoein(client, "10103");
            if (!debitMoeinId || !creditMoeinId) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, error: "سرفصل‌ها تعریف نشده" }); }
            docDesc = `پاس شدن ${chequeInfo} - کسر از بانک ${bank.bank_name} - ${fmtAmt(amount)} ریال`;
            entries = [
                { moein_id: debitMoeinId, tafsili_id: null, bed: amount, bes: 0, description: `تسویه ${chequeInfo} - ${fmtAmt(amount)} ریال` },
                { moein_id: creditMoeinId, tafsili_id: bank.tafsili_id, bed: 0, bes: amount, description: `کسر از ${bank.bank_name} بابت ${chequeInfo} - ${fmtAmt(amount)} ریال` }
            ];
        }

        const docId = await createDocWithEntries(client, member_id, docNo, dateVal, docDesc, 'cheque_pass', entries);
        await client.query("UPDATE public.treasury_checks SET status='passed', target_bank_id=COALESCE(target_bank_id,$3) WHERE id=$1 AND member_id=$2", [id, member_id, bank_id]);

        await client.query('COMMIT');
        return res.json({ success: true, data: { doc_id: docId, doc_no: docNo }, message: `${chequeInfo} پاس شد - سند ${docNo}` });
    } catch (e) { await client.query('ROLLBACK'); return res.status(500).json({ success: false, error: e.message }); }
    finally { client.release(); }
});

/* ================================================================
   برگشت چک واگذاری از بانک (bounce)
   deposited → bounced
   سند: بدهکار طرف حساب (10301) / بستانکار اسناد در جریان وصول (10303)
   
   چک پرداختنی برگشتی:
   issued → bounced
   سند: بدهکار اسناد پرداختنی (30102) / بستانکار طرف حساب (10301)
================================================================ */
router.post("/:id/bounce", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        const member_id = req.user.member_id;
        const { bounce_date, description } = req.body;

        const chk = await client.query("SELECT * FROM public.treasury_checks WHERE id=$1 AND member_id=$2", [id, member_id]);
        if (chk.rows.length === 0) return res.status(404).json({ success: false, error: "چک یافت نشد" });
        const cheque = chk.rows[0];
        if (cheque.status === 'bounced') return res.status(400).json({ success: false, error: "قبلاً برگشت خورده" });

        await client.query('BEGIN');
        const amount = Number(cheque.amount);
        const chequeInfo = `چک شماره ${cheque.cheque_no || ''}`;
        const dateVal = bounce_date || new Date().toISOString().slice(0,10);
        const docNo = await genDocNo(client, member_id);

        let entries, docDesc;

        if (cheque.type === 'receivable') {
            const personTitle = await getPersonTitle(client, cheque.owner_id);
            const debitMoeinId = await findMoein(client, "10301");
            const creditMoeinId = cheque.status === 'deposited' ? await findMoein(client, "10303") : await findMoein(client, "10302");
            if (!debitMoeinId || !creditMoeinId) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, error: "سرفصل‌ها تعریف نشده" }); }
            const creditLabel = cheque.status === 'deposited' ? 'اسناد در جریان وصول' : 'اسناد دریافتنی';
            docDesc = `برگشت ${chequeInfo} - بدهکار ${personTitle} - ${fmtAmt(amount)} ریال`;
            entries = [
                { moein_id: debitMoeinId, tafsili_id: cheque.owner_id, bed: amount, bes: 0, description: `${personTitle} بابت برگشت ${chequeInfo} - ${fmtAmt(amount)} ریال` },
                { moein_id: creditMoeinId, tafsili_id: null, bed: 0, bes: amount, description: `برگشت ${chequeInfo} از ${creditLabel} - ${fmtAmt(amount)} ریال` }
            ];
        } else {
            const personTitle = await getPersonTitle(client, cheque.receiver_id);
            const debitMoeinId = await findMoein(client, "30102");
            const creditMoeinId = await findMoein(client, "10301");
            if (!debitMoeinId || !creditMoeinId) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, error: "سرفصل‌ها تعریف نشده" }); }
            docDesc = `برگشت ${chequeInfo} پرداختنی - ${fmtAmt(amount)} ریال`;
            entries = [
                { moein_id: debitMoeinId, tafsili_id: null, bed: amount, bes: 0, description: `تسویه ${chequeInfo} برگشتی - ${fmtAmt(amount)} ریال` },
                { moein_id: creditMoeinId, tafsili_id: cheque.receiver_id, bed: 0, bes: amount, description: `${personTitle} بابت برگشت ${chequeInfo} - ${fmtAmt(amount)} ریال` }
            ];
        }

        const docId = await createDocWithEntries(client, member_id, docNo, dateVal, docDesc, 'cheque_bounce', entries);
        await client.query("UPDATE public.treasury_checks SET status='bounced', description=COALESCE($3, description) WHERE id=$1 AND member_id=$2", [id, member_id, description || null]);

        await client.query('COMMIT');
        return res.json({ success: true, data: { doc_id: docId, doc_no: docNo }, message: `${chequeInfo} برگشت خورد - سند ${docNo}` });
    } catch (e) { await client.query('ROLLBACK'); return res.status(500).json({ success: false, error: e.message }); }
    finally { client.release(); }
});

/* DELETE CHECK */
router.delete("/:id", authMiddleware, async (req, res) => {
    try {
        const chk = await pool.query("SELECT status FROM public.treasury_checks WHERE id=$1 AND member_id=$2", [req.params.id, req.user.member_id]);
        if (chk.rows.length > 0 && !['pending','issued'].includes(chk.rows[0].status))
            return res.status(400).json({ success: false, error: "فقط چک‌های در انتظار قابل حذف هستند" });
        await pool.query("DELETE FROM public.treasury_checks WHERE id=$1 AND member_id=$2", [req.params.id, req.user.member_id]);
        return res.json({ success: true, message: "حذف شد" });
    } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
