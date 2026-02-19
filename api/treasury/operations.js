// api/treasury/operations.js
const express = require("express");
const { pool } = require("../../supabaseAdmin");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

const findMoeinId = async (client, code) => {
    const res = await client.query('SELECT id FROM public.accounting_moein WHERE code = $1 LIMIT 1', [code]);
    return res.rows.length > 0 ? res.rows[0].id : null;
};

const nullIfEmpty = (v) => (v === '' || v === undefined || v === null) ? null : v;

const generateDocNo = async (client, member_id) => {
    const res = await client.query(
        'SELECT MAX(doc_no::INTEGER) as max_no FROM public.financial_documents WHERE member_id = $1',
        [member_id]
    );
    const max = res.rows[0].max_no || 1000;
    return (Number(max) + 1).toString();
};

/* ================================================================
   POST /api/treasury/register-exit-doc
   ثبت سند خروج
================================================================ */
router.post("/register-exit-doc", authMiddleware, async (req, res) => {
    const client = await pool.connect();

    try {
        const { exit_id } = req.body;
        const targetExitId = exit_id || req.body.exitId;
        const member_id = req.user.member_id || req.user.id;

        if (!targetExitId) return res.status(400).json({ success: false, error: "شناسه خروج ارسال نشده است." });

        await client.query('BEGIN');

        const exitRes = await client.query(
            'SELECT * FROM public.warehouse_exits WHERE id = $1 AND member_id = $2',
            [targetExitId, member_id]
        );

        if (exitRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: "سند خروج یافت نشد." });
        }
        const exitRecord = exitRes.rows[0];

        if (exitRecord.accounting_doc_id) {
            await client.query('ROLLBACK');
            return res.json({ success: true, doc_id: exitRecord.accounting_doc_id, message: "سند قبلاً صادر شده است." });
        }

        const totalAmount = Number(exitRecord.total_fee || 0) +
            Number(exitRecord.total_loading_fee || 0) +
            Number(exitRecord.weighbridge_fee || 0) +
            Number(exitRecord.extra_fee || 0) +
            Number(exitRecord.vat_fee || 0);

        if (totalAmount <= 0) {
            await client.query('ROLLBACK');
            return res.json({ success: true, message: "مبلغ صفر است، سند صادر نشد." });
        }

        let debtorEntry = null;

        if (exitRecord.payment_method === 'credit') {
            const moeinId = await findMoeinId(client, "10301");
            const custRes = await client.query(
                'SELECT tafsili_id FROM public.customers WHERE id = $1',
                [exitRecord.owner_id]
            );
            if (custRes.rows.length === 0 || !custRes.rows[0].tafsili_id) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, error: "حساب تفصیلی مشتری یافت نشد." });
            }
            debtorEntry = {
                moein_id: moeinId,
                tafsili_id: custRes.rows[0].tafsili_id,
                bed: totalAmount,
                bes: 0,
                description: `بابت خدمات خروج شماره ${exitRecord.exit_no || '-'}`
            };
        } else {
            const tafsiliId = exitRecord.financial_account_id;
            if (!tafsiliId) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, error: "حساب بانک/صندوق انتخاب نشده." });
            }
            let moeinCode = "10103";
            if (exitRecord.payment_method === 'cash') moeinCode = "10101";
            else if (exitRecord.payment_method === 'pos') moeinCode = "10104";
            const moeinId = await findMoeinId(client, moeinCode);
            debtorEntry = {
                moein_id: moeinId,
                tafsili_id: tafsiliId,
                bed: totalAmount,
                bes: 0,
                description: `دریافت وجه بابت خروج ${exitRecord.exit_no || '-'}`
            };
        }

        const creditorEntries = [];
        const feeMap = [
            { amount: exitRecord.total_fee, code: "60101", desc: "درآمد انبارداری" },
            { amount: exitRecord.total_loading_fee, code: "60102", desc: "درآمد بارگیری" },
            { amount: exitRecord.weighbridge_fee, code: "60103", desc: "درآمد باسکول" },
            { amount: exitRecord.extra_fee, code: "60104", desc: "سایر درآمدهای عملیاتی" },
            { amount: exitRecord.vat_fee, code: "30201", desc: "مالیات بر ارزش افزوده" }
        ];

        for (const item of feeMap) {
            if (Number(item.amount) > 0) {
                const mId = await findMoeinId(client, item.code);
                if (mId) {
                    creditorEntries.push({
                        moein_id: mId,
                        tafsili_id: null,
                        bed: 0,
                        bes: Number(item.amount),
                        description: item.desc
                    });
                }
            }
        }

        const docNo = await generateDocNo(client, member_id);
        const docDate = exitRecord.exit_date || new Date().toISOString();

        const docRes = await client.query(`
            INSERT INTO public.financial_documents 
            (member_id, doc_no, doc_date, description, status, doc_type)
            VALUES ($1, $2, $3, $4, 'confirmed', 'auto')
            RETURNING id
        `, [member_id, docNo, docDate, `بابت خدمات خروج شماره ${exitRecord.exit_no || ''} - ${exitRecord.driver_name || ''}`]);
        const newDocId = docRes.rows[0].id;

        const allEntries = [debtorEntry, ...creditorEntries];
        for (const entry of allEntries) {
            await client.query(`
                INSERT INTO public.financial_entries 
                (doc_id, member_id, moein_id, tafsili_id, bed, bes, description)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [newDocId, member_id, entry.moein_id, entry.tafsili_id, entry.bed, entry.bes, entry.description]);
        }

        await client.query('UPDATE public.warehouse_exits SET accounting_doc_id = $1 WHERE id = $2', [newDocId, targetExitId]);

        await client.query('COMMIT');

        return res.json({
            success: true,
            doc_id: newDocId,
            doc_no: docNo,
            message: "سند حسابداری با موفقیت صادر شد."
        });

    } catch (e) {
        await client.query('ROLLBACK');
        console.error("❌ Register Exit Doc Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

/* ================================================================
   POST /api/treasury/transactions
   ثبت تراکنش خزانه‌داری (دریافت/پرداخت) با سند حسابداری خودکار

   Transaction types supported:
   - receive: cash, pos, bank_transfer, cheque
   - payment: cash, pos, bank_transfer, cheque (issue_ours, spend_customer)

   Accounting logic:
   RECEIVE:
     cash      -> Debit: Cash account (10101)    / Credit: Customer (10301)
     pos       -> Debit: POS account (10104)     / Credit: Customer (10301)
     bank      -> Debit: Bank account (10103)    / Credit: Customer (10301)
     cheque    -> Debit: Cheques receivable(10201)/ Credit: Customer (10301)

   PAYMENT:
     cash      -> Debit: Customer (10301) / Credit: Cash account (10101)
     pos       -> Debit: Customer (10301) / Credit: POS account (10104)
     bank      -> Debit: Customer (10301) / Credit: Bank account (10103)
     cheque_issue -> Debit: Customer (10301) / Credit: Cheques payable (20101)
     cheque_spend -> Debit: Customer (10301) / Credit: Cheques receivable(10201)
================================================================ */
router.post("/transactions", authMiddleware, async (req, res) => {
    const client = await pool.connect();

    try {
        const member_id = req.user.member_id || req.user.id;
        const { type, date, person_id, description, manual_no, items } = req.body;

        if (!type || !person_id || !items || items.length === 0) {
            return res.status(400).json({ success: false, error: "اطلاعات ناقص است" });
        }

        await client.query('BEGIN');

        const personRes = await client.query(
            'SELECT id, title FROM public.accounting_tafsili WHERE id = $1 AND member_id = $2',
            [person_id, member_id]
        );
        if (personRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: "طرف حساب یافت نشد" });
        }
        const personTitle = personRes.rows[0].title;

        const fmtAmt = (n) => Number(n).toLocaleString('fa-IR');

        const docNo = await generateDocNo(client, member_id);
        const docDate = date || new Date().toISOString().slice(0, 10);
        const typeLabel = type === 'receive' ? 'دریافت' : 'پرداخت';

        const MOEIN_CODES = {
            cash: "10101",
            bank: "10103",
            pos: "10104",
            customer: "10301",
            cheque_recv: "10302",
            cheque_pay: "30102",
            fee: "80205"
        };

        let totalAmount = 0;
        const itemDescs = [];

        const getTafsiliTitle = async (tafsiliId) => {
            if (!tafsiliId) return '';
            const r = await client.query('SELECT title FROM public.accounting_tafsili WHERE id = $1', [tafsiliId]);
            return r.rows.length > 0 ? r.rows[0].title : '';
        };

        const allEntries = [];

        for (const item of items) {
            const amount = Number(item.amount) || 0;
            if (amount <= 0) continue;
            totalAmount += amount;

            const method = item.method;
            let debitMoeinCode, creditMoeinCode, debitTafsili, creditTafsili;
            let debitDesc = '';
            let creditDesc = '';
            const refTitle = item.ref_label || await getTafsiliTitle(item.ref_id);

            if (type === 'receive') {
                creditMoeinCode = MOEIN_CODES.customer;
                creditTafsili = person_id;

                if (method === 'cash') {
                    debitMoeinCode = MOEIN_CODES.cash;
                    debitTafsili = item.ref_id;
                    debitDesc = `دریافت نقدی از ${personTitle} - صندوق: ${refTitle} - مبلغ ${fmtAmt(amount)} ریال`;
                    creditDesc = `${personTitle} بابت دریافت نقدی - صندوق: ${refTitle} - مبلغ ${fmtAmt(amount)} ریال`;
                    itemDescs.push(`نقدی ${fmtAmt(amount)} ریال (${refTitle})`);
                } else if (method === 'pos') {
                    debitMoeinCode = MOEIN_CODES.pos;
                    debitTafsili = item.ref_id;
                    debitDesc = `دریافت از کارتخوان ${refTitle} از ${personTitle} - مبلغ ${fmtAmt(amount)} ریال`;
                    creditDesc = `${personTitle} بابت دریافت کارتخوان - ${refTitle} - مبلغ ${fmtAmt(amount)} ریال`;
                    itemDescs.push(`کارتخوان ${fmtAmt(amount)} ریال (${refTitle})`);
                } else if (method === 'bank_transfer') {
                    debitMoeinCode = MOEIN_CODES.bank;
                    debitTafsili = item.ref_id;
                    debitDesc = `واریز بانکی از ${personTitle} به حساب ${refTitle} - مبلغ ${fmtAmt(amount)} ریال`;
                    creditDesc = `${personTitle} بابت واریز بانکی - حساب ${refTitle} - مبلغ ${fmtAmt(amount)} ریال`;
                    itemDescs.push(`واریز بانکی ${fmtAmt(amount)} ریال (${refTitle})`);
                } else if (method === 'cheque') {
                    debitMoeinCode = MOEIN_CODES.cheque_recv;
                    debitTafsili = null;
                    const chequeInfo = item.cheque_no ? `شماره چک: ${item.cheque_no}` : '';
                    const dueDateInfo = item.due_date ? ` - سررسید: ${item.due_date}` : '';
                    const bankInfo = item.bank_name ? ` - بانک: ${item.bank_name}` : '';
                    debitDesc = `دریافت چک از ${personTitle} - ${chequeInfo}${bankInfo}${dueDateInfo} - مبلغ ${fmtAmt(amount)} ریال`;
                    creditDesc = `${personTitle} بابت صدور چک ${chequeInfo}${dueDateInfo} - مبلغ ${fmtAmt(amount)} ریال`;
                    itemDescs.push(`چک ${item.cheque_no || ''} - ${fmtAmt(amount)} ریال`);

                    await client.query(`
                        INSERT INTO public.treasury_checks (
                            member_id, type, cheque_no, sayadi_code, 
                            amount, due_date, status, bank_name, 
                            account_holder, description, checkbook_id, owner_id
                        ) VALUES ($1, 'receivable', $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10)
                    `, [
                        member_id, item.cheque_no, nullIfEmpty(item.sayadi_code),
                        amount, nullIfEmpty(item.due_date), nullIfEmpty(item.bank_name),
                        nullIfEmpty(item.account_holder), 
                        `دریافت از ${personTitle}`,
                        nullIfEmpty(item.checkbook_id),
                        person_id
                    ]);
                }
            } else {
                debitMoeinCode = MOEIN_CODES.customer;
                debitTafsili = person_id;

                if (method === 'cash') {
                    creditMoeinCode = MOEIN_CODES.cash;
                    creditTafsili = item.ref_id;
                    debitDesc = `${personTitle} بابت پرداخت نقدی - صندوق: ${refTitle} - مبلغ ${fmtAmt(amount)} ریال`;
                    creditDesc = `پرداخت نقدی به ${personTitle} از صندوق ${refTitle} - مبلغ ${fmtAmt(amount)} ریال`;
                    itemDescs.push(`نقدی ${fmtAmt(amount)} ریال (${refTitle})`);
                } else if (method === 'pos') {
                    creditMoeinCode = MOEIN_CODES.pos;
                    creditTafsili = item.ref_id;
                    debitDesc = `${personTitle} بابت پرداخت کارتخوان - ${refTitle} - مبلغ ${fmtAmt(amount)} ریال`;
                    creditDesc = `پرداخت کارتخوان به ${personTitle} از ${refTitle} - مبلغ ${fmtAmt(amount)} ریال`;
                    itemDescs.push(`کارتخوان ${fmtAmt(amount)} ریال (${refTitle})`);
                } else if (method === 'bank_transfer') {
                    creditMoeinCode = MOEIN_CODES.bank;
                    creditTafsili = item.ref_id;
                    debitDesc = `${personTitle} بابت حواله بانکی - حساب ${refTitle} - مبلغ ${fmtAmt(amount)} ریال`;
                    creditDesc = `حواله بانکی به ${personTitle} از حساب ${refTitle} - مبلغ ${fmtAmt(amount)} ریال`;
                    itemDescs.push(`حواله بانکی ${fmtAmt(amount)} ریال (${refTitle})`);
                } else if (method === 'cheque') {
                    const chequeType = item.cheque_type;
                    const chequeInfo = item.cheque_no ? `شماره چک: ${item.cheque_no}` : '';
                    const dueDateInfo = item.due_date ? ` - سررسید: ${item.due_date}` : '';
                    const bankInfo = item.bank_name ? ` - بانک: ${item.bank_name}` : '';

                    if (chequeType === 'issue_ours') {
                        creditMoeinCode = MOEIN_CODES.cheque_pay;
                        creditTafsili = null;
                        debitDesc = `${personTitle} بابت صدور چک ${chequeInfo}${dueDateInfo} - مبلغ ${fmtAmt(amount)} ریال`;
                        creditDesc = `صدور چک به ${personTitle} - ${chequeInfo}${bankInfo}${dueDateInfo} - مبلغ ${fmtAmt(amount)} ریال`;
                        itemDescs.push(`صدور چک ${item.cheque_no || ''} - ${fmtAmt(amount)} ریال`);

                        await client.query(`
                            INSERT INTO public.treasury_checks (
                                member_id, type, cheque_no, sayadi_code, 
                                amount, due_date, status, bank_name, 
                                account_holder, description, checkbook_id, receiver_id
                            ) VALUES ($1, 'payable', $2, $3, $4, $5, 'issued', $6, $7, $8, $9, $10)
                        `, [
                            member_id, item.cheque_no, nullIfEmpty(item.sayadi_code),
                            amount, nullIfEmpty(item.due_date), nullIfEmpty(item.bank_name),
                            nullIfEmpty(item.account_holder),
                            `صدور به ${personTitle}`,
                            nullIfEmpty(item.checkbook_id),
                            person_id
                        ]);
                    } else {
                        creditMoeinCode = MOEIN_CODES.cheque_recv;
                        creditTafsili = null;
                        debitDesc = `${personTitle} بابت خرج چک دریافتی ${chequeInfo} - مبلغ ${fmtAmt(amount)} ریال`;
                        creditDesc = `خرج چک دریافتی ${chequeInfo} بابت پرداخت به ${personTitle} - مبلغ ${fmtAmt(amount)} ریال`;
                        itemDescs.push(`خرج چک ${item.cheque_no || ''} - ${fmtAmt(amount)} ریال`);

                        if (item.check_id) {
                            await client.query(
                                "UPDATE public.treasury_checks SET status = 'spent', receiver_id = $3 WHERE id = $1 AND member_id = $2",
                                [item.check_id, member_id, person_id]
                            );
                        }
                    }
                }
            }

            const debitMoeinId = await findMoeinId(client, debitMoeinCode);
            if (!debitMoeinId) throw new Error(`حساب معین با کد ${debitMoeinCode} یافت نشد. لطفاً ابتدا سرفصل‌های حسابداری را تعریف کنید.`);
            
            const creditMoeinId = await findMoeinId(client, creditMoeinCode);
            if (!creditMoeinId) throw new Error(`حساب معین با کد ${creditMoeinCode} یافت نشد. لطفاً ابتدا سرفصل‌های حسابداری را تعریف کنید.`);

            allEntries.push(
                { moein_id: debitMoeinId, tafsili_id: debitTafsili, bed: amount, bes: 0, description: debitDesc },
                { moein_id: creditMoeinId, tafsili_id: creditTafsili, bed: 0, bes: amount, description: creditDesc }
            );

            if (item.fee && Number(item.fee) > 0) {
                const feeAmount = Number(item.fee);
                const feeMoeinId = await findMoeinId(client, MOEIN_CODES.fee);
                const bankMoeinId = await findMoeinId(client, MOEIN_CODES.bank);
                
                allEntries.push(
                    { moein_id: feeMoeinId, tafsili_id: null, bed: feeAmount, bes: 0, description: `کارمزد بانکی - مبلغ ${fmtAmt(feeAmount)} ریال` },
                    { moein_id: bankMoeinId, tafsili_id: item.ref_id, bed: 0, bes: feeAmount, description: `کارمزد بانکی از حساب ${refTitle} - مبلغ ${fmtAmt(feeAmount)} ریال` }
                );
            }
        }

        const docDesc = description || 
            `${typeLabel} وجه از/به ${personTitle} - جمع: ${fmtAmt(totalAmount)} ریال - ${itemDescs.join(' / ')}`;

        const docResult = await client.query(`
            INSERT INTO public.financial_documents 
            (member_id, doc_no, doc_date, description, status, doc_type)
            VALUES ($1, $2, $3, $4, 'confirmed', 'treasury')
            RETURNING id
        `, [member_id, docNo, docDate, docDesc]);
        const docId = docResult.rows[0].id;

        for (const entry of allEntries) {
            await client.query(`
                INSERT INTO public.financial_entries 
                (doc_id, member_id, moein_id, tafsili_id, bed, bes, description)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [docId, member_id, entry.moein_id, entry.tafsili_id, entry.bed, entry.bes, entry.description]);
        }

        await client.query('COMMIT');

        return res.json({
            success: true,
            data: {
                doc_id: docId,
                doc_no: docNo,
                total_amount: totalAmount
            },
            message: `سند ${typeLabel} شماره ${docNo} با موفقیت ثبت شد - ${personTitle} - جمع: ${fmtAmt(totalAmount)} ریال`
        });

    } catch (e) {
        await client.query('ROLLBACK');
        console.error("❌ Treasury Transaction Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

/* ================================================================
   POST /api/treasury/transfer
   انتقال بین حساب‌ها (بانک به بانک، بانک به صندوق، صندوق به بانک)
================================================================ */
router.post("/transfer", authMiddleware, async (req, res) => {
    const client = await pool.connect();

    try {
        const member_id = req.user.member_id || req.user.id;
        const { 
            from_type, from_id,   // source: 'bank', 'cash' + tafsili_id
            to_type, to_id,       // destination: 'bank', 'cash' + tafsili_id
            amount, fee, date, description, tracking_no 
        } = req.body;

        if (!from_id || !to_id || !amount || Number(amount) <= 0) {
            return res.status(400).json({ success: false, error: "اطلاعات انتقال ناقص است" });
        }

        await client.query('BEGIN');

        const docNo = await generateDocNo(client, member_id);
        const docDate = date || new Date().toISOString().slice(0, 10);
        const amountVal = Number(amount);
        const feeVal = Number(fee) || 0;

        // Determine moein codes
        const fromMoeinCode = from_type === 'cash' ? '10101' : '10103';
        const toMoeinCode = to_type === 'cash' ? '10101' : '10103';

        const descText = description || `انتقال از ${from_type === 'cash' ? 'صندوق' : 'بانک'} به ${to_type === 'cash' ? 'صندوق' : 'بانک'}`;

        // Create document
        const docResult = await client.query(`
            INSERT INTO public.financial_documents 
            (member_id, doc_no, doc_date, description, status, doc_type)
            VALUES ($1, $2, $3, $4, 'confirmed', 'transfer')
            RETURNING id
        `, [member_id, docNo, docDate, descText]);
        const docId = docResult.rows[0].id;

        // Debit destination (receives money)
        const toMoeinId = await findMoeinId(client, toMoeinCode);
        await client.query(`
            INSERT INTO public.financial_entries 
            (doc_id, member_id, moein_id, tafsili_id, bed, bes, description)
            VALUES ($1, $2, $3, $4, $5, 0, $6)
        `, [docId, member_id, toMoeinId, to_id, amountVal, descText]);

        // Credit source (sends money)
        const fromMoeinId = await findMoeinId(client, fromMoeinCode);
        await client.query(`
            INSERT INTO public.financial_entries 
            (doc_id, member_id, moein_id, tafsili_id, bed, bes, description)
            VALUES ($1, $2, $3, $4, 0, $5, $6)
        `, [docId, member_id, fromMoeinId, from_id, amountVal, descText]);

        // Fee entry if applicable
        if (feeVal > 0) {
            const feeMoeinId = await findMoeinId(client, '80205');
            await client.query(`
                INSERT INTO public.financial_entries 
                (doc_id, member_id, moein_id, tafsili_id, bed, bes, description)
                VALUES ($1, $2, $3, NULL, $4, 0, $5)
            `, [docId, member_id, feeMoeinId, feeVal, 'کارمزد انتقال']);

            await client.query(`
                INSERT INTO public.financial_entries 
                (doc_id, member_id, moein_id, tafsili_id, bed, bes, description)
                VALUES ($1, $2, $3, $4, 0, $5, $6)
            `, [docId, member_id, fromMoeinId, from_id, feeVal, 'کارمزد انتقال']);
        }

        await client.query('COMMIT');

        return res.json({
            success: true,
            data: { doc_id: docId, doc_no: docNo },
            message: `سند انتقال شماره ${docNo} ثبت شد`
        });

    } catch (e) {
        await client.query('ROLLBACK');
        console.error("❌ Transfer Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

module.exports = router;
