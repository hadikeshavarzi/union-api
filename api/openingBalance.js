const express = require("express");
const router = express.Router();
const { pool } = require("../supabaseAdmin");
const authMiddleware = require("./middleware/auth");

router.use(authMiddleware);

const SECTIONS = ["inventory", "customers", "banks", "cashes"];

/* ─── GET /status - وضعیت تمام بخش‌ها ─── */
router.get("/status", async (req, res) => {
    try {
        const memberId = req.user.member_id || req.user.id;
        const { rows } = await pool.query(
            `SELECT section, created_at FROM opening_balances WHERE member_id = $1`, [memberId]
        );
        const status = {};
        SECTIONS.forEach(s => { status[s] = null; });
        rows.forEach(r => { status[r.section] = r.created_at; });
        res.json({ success: true, data: status });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/* ─── GET /inventory - موجودی کالا ─── */
router.get("/inventory", async (req, res) => {
    try {
        const memberId = req.user.member_id || req.user.id;
        const { rows } = await pool.query(
            `SELECT ob.*, json_agg(json_build_object(
                'id', obi.id, 'product_id', obi.product_id, 'owner_id', obi.owner_id,
                'qty', obi.qty, 'weight', obi.weight, 'batch_no', obi.batch_no,
                'description', obi.description, 'product_name', p.name, 'owner_name', c.name
             ) ORDER BY obi.created_at) AS items
             FROM opening_balances ob
             LEFT JOIN opening_balance_items obi ON obi.opening_balance_id = ob.id
             LEFT JOIN products p ON p.id = obi.product_id
             LEFT JOIN customers c ON c.id = obi.owner_id
             WHERE ob.member_id = $1 AND ob.section = 'inventory'
             GROUP BY ob.id`, [memberId]
        );
        res.json({ success: true, exists: rows.length > 0, data: rows[0] || null });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/* ─── POST /inventory - ثبت موجودی کالا ─── */
router.post("/inventory", async (req, res) => {
    const client = await pool.connect();
    try {
        const memberId = req.user.member_id || req.user.id;
        const { items, description } = req.body;
        if (!items || !items.length) return res.status(400).json({ success: false, error: "حداقل یک آیتم وارد کنید" });

        await client.query("BEGIN");
        const { rows: existing } = await client.query(
            `SELECT id FROM opening_balances WHERE member_id = $1 AND section = 'inventory' FOR UPDATE`, [memberId]
        );
        if (existing.length > 0) {
            await client.query("ROLLBACK");
            return res.status(400).json({ success: false, error: "اول دوره کالا قبلاً ثبت شده است." });
        }

        const { rows: obRows } = await client.query(
            `INSERT INTO opening_balances (member_id, section, description, created_by) VALUES ($1, 'inventory', $2, $3) RETURNING id`,
            [memberId, description || "موجودی اول دوره - کالا", req.user.id]
        );
        const obId = obRows[0].id;
        let count = 0;

        for (const item of items) {
            if (!item.product_id || !item.owner_id) continue;
            const qty = Number(item.qty) || 0;
            const weight = Number(item.weight) || 0;
            if (qty <= 0 && weight <= 0) continue;

            await client.query(
                `INSERT INTO opening_balance_items (opening_balance_id, product_id, owner_id, qty, weight, batch_no, description)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [obId, item.product_id, item.owner_id, qty, weight, item.batch_no || null, item.description || null]
            );
            await client.query(
                `INSERT INTO inventory_transactions (type, transaction_type, reference_id, product_id, owner_id, member_id,
                    qty, weight, qty_real, weight_real, qty_available, weight_available, batch_no, transaction_date, created_at, updated_at)
                 VALUES ('in','opening_balance',$1,$2,$3,$4,$5,$6,$5,$6,$5,$6,$7,NOW(),NOW(),NOW())`,
                [obId, item.product_id, item.owner_id, memberId, qty, weight, item.batch_no || null]
            );
            count++;
        }

        if (count === 0) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, error: "هیچ آیتم معتبری یافت نشد" }); }
        await client.query("COMMIT");
        res.json({ success: true, message: `اول دوره کالا با ${count} آیتم ثبت شد` });
    } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        if (e.code === "23505") return res.status(400).json({ success: false, error: "اول دوره کالا قبلاً ثبت شده است." });
        res.status(500).json({ success: false, error: e.message });
    } finally { client.release(); }
});

/* ─── GET /customers - مانده اشخاص ─── */
router.get("/customers", async (req, res) => {
    try {
        const memberId = req.user.member_id || req.user.id;
        const { rows } = await pool.query(
            `SELECT ob.*, json_agg(json_build_object(
                'id', obc.id, 'customer_id', obc.customer_id, 'balance_type', obc.balance_type,
                'amount', obc.amount, 'description', obc.description, 'customer_name', c.name
             ) ORDER BY obc.created_at) AS items
             FROM opening_balances ob
             LEFT JOIN opening_balance_customers obc ON obc.opening_balance_id = ob.id
             LEFT JOIN customers c ON c.id = obc.customer_id
             WHERE ob.member_id = $1 AND ob.section = 'customers'
             GROUP BY ob.id`, [memberId]
        );
        res.json({ success: true, exists: rows.length > 0, data: rows[0] || null });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/* ─── POST /customers - ثبت مانده اشخاص ─── */
router.post("/customers", async (req, res) => {
    const client = await pool.connect();
    try {
        const memberId = req.user.member_id || req.user.id;
        const { items, description } = req.body;
        if (!items || !items.length) return res.status(400).json({ success: false, error: "حداقل یک آیتم وارد کنید" });

        await client.query("BEGIN");
        const { rows: existing } = await client.query(
            `SELECT id FROM opening_balances WHERE member_id = $1 AND section = 'customers' FOR UPDATE`, [memberId]
        );
        if (existing.length > 0) {
            await client.query("ROLLBACK");
            return res.status(400).json({ success: false, error: "اول دوره اشخاص قبلاً ثبت شده است." });
        }

        const { rows: obRows } = await client.query(
            `INSERT INTO opening_balances (member_id, section, description, created_by) VALUES ($1, 'customers', $2, $3) RETURNING id`,
            [memberId, description || "مانده اول دوره - اشخاص", req.user.id]
        );
        const obId = obRows[0].id;

        const { rows: docRows } = await client.query(
            `INSERT INTO financial_documents (member_id, doc_date, description, status, doc_type, reference_id, reference_type, created_at, updated_at)
             VALUES ($1, NOW(), $2, 'confirmed', 'opening_balance', $3, 'opening_balance', NOW(), NOW()) RETURNING id`,
            [memberId, "سند اول دوره - مانده اشخاص", obId]
        );
        const docId = docRows[0].id;

        let count = 0;
        for (const item of items) {
            if (!item.customer_id || !item.amount || Number(item.amount) <= 0) continue;
            const amount = Number(item.amount);
            const balanceType = item.balance_type || "bedehkar";

            await client.query(
                `INSERT INTO opening_balance_customers (opening_balance_id, customer_id, balance_type, amount, description)
                 VALUES ($1, $2, $3, $4, $5)`,
                [obId, item.customer_id, balanceType, amount, item.description || null]
            );

            const { rows: tafsiliRows } = await client.query(
                `SELECT id FROM accounting_tafsili WHERE ref_id = $1 AND tafsili_type = 'customer' AND member_id = $2 LIMIT 1`,
                [item.customer_id, memberId]
            );

            if (tafsiliRows.length > 0) {
                const moeinCode = "10301";
                const { rows: moeinRows } = await client.query(
                    `SELECT id FROM accounting_moein WHERE code = $1 LIMIT 1`, [moeinCode]
                );
                const moeinId = moeinRows[0]?.id || null;

                await client.query(
                    `INSERT INTO financial_entries (doc_id, member_id, moein_id, tafsili_id, bed, bes, description, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
                    [docId, memberId, moeinId, tafsiliRows[0].id,
                     balanceType === "bedehkar" ? amount : 0,
                     balanceType === "bestankar" ? amount : 0,
                     `اول دوره - ${item.description || "مانده شخص"}`]
                );
            }
            count++;
        }

        if (count === 0) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, error: "هیچ آیتم معتبری یافت نشد" }); }
        await client.query("COMMIT");
        res.json({ success: true, message: `اول دوره اشخاص با ${count} آیتم ثبت شد` });
    } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        if (e.code === "23505") return res.status(400).json({ success: false, error: "اول دوره اشخاص قبلاً ثبت شده است." });
        res.status(500).json({ success: false, error: e.message });
    } finally { client.release(); }
});

/* ─── GET /banks ─── */
router.get("/banks", async (req, res) => {
    try {
        const memberId = req.user.member_id || req.user.id;
        const { rows } = await pool.query(
            `SELECT ob.*, json_agg(json_build_object(
                'id', obb.id, 'bank_id', obb.bank_id, 'amount', obb.amount,
                'description', obb.description, 'bank_name', tb.bank_name, 'account_no', tb.account_no
             ) ORDER BY obb.created_at) AS items
             FROM opening_balances ob
             LEFT JOIN opening_balance_banks obb ON obb.opening_balance_id = ob.id
             LEFT JOIN treasury_banks tb ON tb.id = obb.bank_id
             WHERE ob.member_id = $1 AND ob.section = 'banks'
             GROUP BY ob.id`, [memberId]
        );
        res.json({ success: true, exists: rows.length > 0, data: rows[0] || null });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/* ─── POST /banks ─── */
router.post("/banks", async (req, res) => {
    const client = await pool.connect();
    try {
        const memberId = req.user.member_id || req.user.id;
        const { items, description } = req.body;
        if (!items || !items.length) return res.status(400).json({ success: false, error: "حداقل یک بانک وارد کنید" });

        await client.query("BEGIN");
        const { rows: existing } = await client.query(
            `SELECT id FROM opening_balances WHERE member_id = $1 AND section = 'banks' FOR UPDATE`, [memberId]
        );
        if (existing.length > 0) {
            await client.query("ROLLBACK");
            return res.status(400).json({ success: false, error: "اول دوره بانک قبلاً ثبت شده است." });
        }

        const { rows: obRows } = await client.query(
            `INSERT INTO opening_balances (member_id, section, description, created_by) VALUES ($1, 'banks', $2, $3) RETURNING id`,
            [memberId, description || "مانده اول دوره - بانک", req.user.id]
        );
        const obId = obRows[0].id;

        let count = 0;
        for (const item of items) {
            if (!item.bank_id || !item.amount || Number(item.amount) <= 0) continue;
            const amount = Number(item.amount);

            await client.query(
                `INSERT INTO opening_balance_banks (opening_balance_id, bank_id, amount, description) VALUES ($1, $2, $3, $4)`,
                [obId, item.bank_id, amount, item.description || null]
            );
            await client.query(
                `UPDATE treasury_banks SET initial_balance = $1 WHERE id = $2 AND member_id = $3`,
                [amount, item.bank_id, memberId]
            );
            count++;
        }

        if (count === 0) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, error: "هیچ آیتم معتبری یافت نشد" }); }
        await client.query("COMMIT");
        res.json({ success: true, message: `اول دوره بانک با ${count} آیتم ثبت شد` });
    } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        if (e.code === "23505") return res.status(400).json({ success: false, error: "اول دوره بانک قبلاً ثبت شده است." });
        res.status(500).json({ success: false, error: e.message });
    } finally { client.release(); }
});

/* ─── GET /cashes ─── */
router.get("/cashes", async (req, res) => {
    try {
        const memberId = req.user.member_id || req.user.id;
        const { rows } = await pool.query(
            `SELECT ob.*, json_agg(json_build_object(
                'id', obc.id, 'cash_id', obc.cash_id, 'amount', obc.amount,
                'description', obc.description, 'cash_title', tc.title
             ) ORDER BY obc.created_at) AS items
             FROM opening_balances ob
             LEFT JOIN opening_balance_cashes obc ON obc.opening_balance_id = ob.id
             LEFT JOIN treasury_cashes tc ON tc.id = obc.cash_id
             WHERE ob.member_id = $1 AND ob.section = 'cashes'
             GROUP BY ob.id`, [memberId]
        );
        res.json({ success: true, exists: rows.length > 0, data: rows[0] || null });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/* ─── POST /cashes ─── */
router.post("/cashes", async (req, res) => {
    const client = await pool.connect();
    try {
        const memberId = req.user.member_id || req.user.id;
        const { items, description } = req.body;
        if (!items || !items.length) return res.status(400).json({ success: false, error: "حداقل یک صندوق وارد کنید" });

        await client.query("BEGIN");
        const { rows: existing } = await client.query(
            `SELECT id FROM opening_balances WHERE member_id = $1 AND section = 'cashes' FOR UPDATE`, [memberId]
        );
        if (existing.length > 0) {
            await client.query("ROLLBACK");
            return res.status(400).json({ success: false, error: "اول دوره صندوق قبلاً ثبت شده است." });
        }

        const { rows: obRows } = await client.query(
            `INSERT INTO opening_balances (member_id, section, description, created_by) VALUES ($1, 'cashes', $2, $3) RETURNING id`,
            [memberId, description || "مانده اول دوره - صندوق", req.user.id]
        );
        const obId = obRows[0].id;

        let count = 0;
        for (const item of items) {
            if (!item.cash_id || !item.amount || Number(item.amount) <= 0) continue;
            const amount = Number(item.amount);

            await client.query(
                `INSERT INTO opening_balance_cashes (opening_balance_id, cash_id, amount, description) VALUES ($1, $2, $3, $4)`,
                [obId, item.cash_id, amount, item.description || null]
            );
            await client.query(
                `UPDATE treasury_cashes SET initial_balance = $1 WHERE id = $2 AND member_id = $3`,
                [amount, item.cash_id, memberId]
            );
            count++;
        }

        if (count === 0) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, error: "هیچ آیتم معتبری یافت نشد" }); }
        await client.query("COMMIT");
        res.json({ success: true, message: `اول دوره صندوق با ${count} آیتم ثبت شد` });
    } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        if (e.code === "23505") return res.status(400).json({ success: false, error: "اول دوره صندوق قبلاً ثبت شده است." });
        res.status(500).json({ success: false, error: e.message });
    } finally { client.release(); }
});

module.exports = router;
