const express = require("express");
const { pool } = require("../supabaseAdmin");
const router = express.Router();

const isUUID = (str) => str && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
const formatDate = (d) => { if (!d) return null; try { return new Date(d).toLocaleDateString("fa-IR"); } catch { return null; } };
const fNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

async function getWarehouseName(memberId) {
    try {
        const { rows } = await pool.query(
            "SELECT full_name, company_name, business_name FROM members WHERE id = $1 LIMIT 1",
            [memberId]
        );
        if (!rows.length) return "انبار";
        const m = rows[0];
        return m.company_name || m.business_name || m.full_name || "انبار";
    } catch { return "انبار"; }
}

router.get("/receipt/:id", async (req, res) => {
    try {
        const { id } = req.params;
        if (!isUUID(id)) return res.status(400).json({ success: false, error: "شناسه نامعتبر" });

        const headerSql = `
            SELECT r.id, r.receipt_no, r.doc_date, r.status, r.member_id,
                   r.driver_name, r.tracking_code,
                   r.plate_iran_right, r.plate_mid3, r.plate_letter, r.plate_left2,
                   c.name AS owner_name
            FROM public.receipts r
            LEFT JOIN public.customers c ON c.id = r.owner_id
            WHERE r.id = $1 LIMIT 1`;
        const { rows: headers } = await pool.query(headerSql, [id]);
        if (!headers.length) return res.status(404).json({ success: false, error: "سند یافت نشد" });
        const h = headers[0];

        const itemsSql = `
            SELECT ri.parent_row, ri.count, ri.weights_net, ri.row_code,
                   ri.brand, ri.depo_location, ri.description_notes,
                   p.name AS product_name
            FROM public.receipt_items ri
            LEFT JOIN public.products p ON p.id = ri.product_id
            WHERE ri.receipt_id = $1
            ORDER BY ri.created_at ASC`;
        const { rows: items } = await pool.query(itemsSql, [id]);

        const warehouseName = await getWarehouseName(h.member_id);
        const plate = (h.plate_left2 || h.plate_mid3 || h.plate_letter || h.plate_iran_right)
            ? `${h.plate_left2 || ""}-${h.plate_mid3 || ""}-${h.plate_letter || ""}-${h.plate_iran_right || ""}`
            : null;

        res.json({
            success: true,
            data: {
                type: "receipt",
                title: "رسید ورود کالا",
                doc_no: h.receipt_no,
                doc_date: formatDate(h.doc_date),
                status: h.status,
                owner_name: h.owner_name,
                driver_name: h.driver_name,
                tracking_code: h.tracking_code,
                plate,
                warehouse_name: warehouseName,
                items: items.map((i, idx) => ({
                    row: idx + 1,
                    product_name: i.product_name || "-",
                    parent_row: i.parent_row || null,
                    count: fNum(i.count),
                    weight_net: fNum(i.weights_net),
                })),
                total_count: items.reduce((s, i) => s + fNum(i.count), 0),
                total_weight: items.reduce((s, i) => s + fNum(i.weights_net), 0),
            }
        });
    } catch (e) {
        console.error("Public Receipt Error:", e.message);
        res.status(500).json({ success: false, error: "خطای سرور" });
    }
});

router.get("/exit/:id", async (req, res) => {
    try {
        const { id } = req.params;
        if (!isUUID(id)) return res.status(400).json({ success: false, error: "شناسه نامعتبر" });

        const { rows: headers } = await pool.query(
            `SELECT e.id, e.exit_no, e.exit_date, e.member_id,
                    e.driver_name, e.driver_national_code, e.plate_number, e.reference_no,
                    e.total_fee, e.total_loading_fee, e.weighbridge_fee, e.extra_fee, e.vat_fee,
                    e.payment_method,
                    c.name AS customer_name
             FROM public.warehouse_exits e
             LEFT JOIN public.customers c ON c.id = e.owner_id
             WHERE e.id = $1 LIMIT 1`, [id]
        );
        if (!headers.length) return res.status(404).json({ success: false, error: "سند یافت نشد" });
        const h = headers[0];

        const { rows: exitItems } = await pool.query(
            `SELECT ei.qty, ei.weight_full, ei.weight_empty, ei.weight_net, ei.final_fee,
                    li.batch_no, p.name AS product_name
             FROM public.warehouse_exit_items ei
             LEFT JOIN public.loading_order_items li ON li.id = ei.loading_item_id
             LEFT JOIN public.products p ON p.id = li.product_id
             WHERE ei.warehouse_exit_id = $1`, [id]
        );

        const warehouseName = await getWarehouseName(h.member_id);

        res.json({
            success: true,
            data: {
                type: "exit",
                title: "سند خروج کالا",
                doc_no: h.exit_no,
                doc_date: formatDate(h.exit_date),
                owner_name: h.customer_name,
                driver_name: h.driver_name,
                plate: h.plate_number,
                reference_no: h.reference_no,
                warehouse_name: warehouseName,
                items: exitItems.map((i, idx) => ({
                    row: idx + 1,
                    product_name: i.product_name || "-",
                    batch_no: i.batch_no || null,
                    qty: fNum(i.qty),
                    weight_net: fNum(i.weight_net),
                })),
                total_qty: exitItems.reduce((s, i) => s + fNum(i.qty), 0),
                total_weight: exitItems.reduce((s, i) => s + fNum(i.weight_net), 0),
            }
        });
    } catch (e) {
        console.error("Public Exit Error:", e.message);
        res.status(500).json({ success: false, error: "خطای سرور" });
    }
});

router.get("/loading/:id", async (req, res) => {
    try {
        const { id } = req.params;
        if (!isUUID(id)) return res.status(400).json({ success: false, error: "شناسه نامعتبر" });

        const { rows: headers } = await pool.query(
            `SELECT lo.id, lo.order_no, lo.loading_date, lo.member_id,
                    lo.driver_name, lo.plate_number, lo.description,
                    c.name AS customer_name,
                    cl.clearance_no, cl.receiver_person_name
             FROM public.loading_orders lo
             LEFT JOIN clearances cl ON cl.id = lo.clearance_id
             LEFT JOIN customers c ON c.id = cl.customer_id
             WHERE lo.id = $1 LIMIT 1`, [id]
        );
        if (!headers.length) return res.status(404).json({ success: false, error: "سند یافت نشد" });
        const h = headers[0];

        const { rows: items } = await pool.query(
            `SELECT li.qty, li.weight, li.batch_no, p.name AS product_name
             FROM public.loading_order_items li
             LEFT JOIN products p ON p.id = li.product_id
             WHERE li.loading_order_id = $1`, [id]
        );

        const warehouseName = await getWarehouseName(h.member_id);

        res.json({
            success: true,
            data: {
                type: "loading",
                title: "حواله بارگیری",
                doc_no: h.order_no,
                doc_date: formatDate(h.loading_date),
                owner_name: h.customer_name,
                driver_name: h.driver_name,
                plate: h.plate_number,
                clearance_no: h.clearance_no,
                receiver_name: h.receiver_person_name,
                warehouse_name: warehouseName,
                items: items.map((i, idx) => ({
                    row: idx + 1,
                    product_name: i.product_name || "-",
                    batch_no: i.batch_no || null,
                    qty: fNum(i.qty),
                    weight: fNum(i.weight),
                })),
                total_qty: items.reduce((s, i) => s + fNum(i.qty), 0),
                total_weight: items.reduce((s, i) => s + fNum(i.weight), 0),
            }
        });
    } catch (e) {
        console.error("Public Loading Error:", e.message);
        res.status(500).json({ success: false, error: "خطای سرور" });
    }
});

router.get("/clearance/:id", async (req, res) => {
    try {
        const { id } = req.params;
        if (!isUUID(id)) return res.status(400).json({ success: false, error: "شناسه نامعتبر" });

        const { rows: headers } = await pool.query(
            `SELECT c.id, c.clearance_no, c.clearance_date, c.member_id,
                    c.receiver_person_name, c.receiver_person_national_id,
                    c.driver_name, c.description,
                    c.vehicle_plate_left2, c.vehicle_plate_mid3, c.vehicle_plate_letter, c.vehicle_plate_iran_right,
                    cust.name AS customer_name
             FROM clearances c
             LEFT JOIN customers cust ON cust.id = c.customer_id
             WHERE c.id = $1 LIMIT 1`, [id]
        );
        if (!headers.length) return res.status(404).json({ success: false, error: "سند یافت نشد" });
        const h = headers[0];

        const { rows: items } = await pool.query(
            `SELECT ci.qty, ci.weight, ci.parent_batch_no, ci.new_batch_no,
                    p.name AS product_name
             FROM clearance_items ci
             LEFT JOIN products p ON p.id = ci.product_id
             WHERE ci.clearance_id = $1
             ORDER BY ci.created_at`, [id]
        );

        const warehouseName = await getWarehouseName(h.member_id);

        res.json({
            success: true,
            data: {
                type: "clearance",
                title: "مجوز ترخیص کالا",
                doc_no: h.clearance_no,
                doc_date: formatDate(h.clearance_date),
                owner_name: h.customer_name,
                receiver_name: h.receiver_person_name,
                receiver_national_id: h.receiver_person_national_id,
                driver_name: h.driver_name,
                plate: (h.vehicle_plate_left2 || h.vehicle_plate_mid3 || h.vehicle_plate_letter || h.vehicle_plate_iran_right)
                    ? `${h.vehicle_plate_left2 || ""}-${h.vehicle_plate_mid3 || ""}-${h.vehicle_plate_letter || ""}-${h.vehicle_plate_iran_right || ""}`
                    : null,
                warehouse_name: warehouseName,
                items: items.map((i, idx) => ({
                    row: idx + 1,
                    product_name: i.product_name || "-",
                    batch_no: i.new_batch_no || i.parent_batch_no || null,
                    qty: fNum(i.qty),
                    weight: fNum(i.weight),
                })),
                total_qty: items.reduce((s, i) => s + fNum(i.qty), 0),
                total_weight: items.reduce((s, i) => s + fNum(i.weight), 0),
            }
        });
    } catch (e) {
        console.error("Public Clearance Error:", e.message);
        res.status(500).json({ success: false, error: "خطای سرور" });
    }
});

module.exports = router;
