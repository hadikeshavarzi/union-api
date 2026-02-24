const axios = require("axios");
const { pool } = require("../../supabaseAdmin");

const NWMS_BASE = "https://pub-cix.ntsw.ir/Services";

async function getNwmsConfig(memberId) {
    const { rows } = await pool.query(
        `SELECT form_settings->'integration' AS cfg FROM warehouse_settings WHERE member_id = $1 LIMIT 1`,
        [memberId]
    );
    const cfg = rows[0]?.cfg;
    if (!cfg || !cfg.nwmsBasicUser || !cfg.nwmsAuthToken) return null;
    return cfg;
}

function buildAuthHeaders(cfg) {
    const basic = Buffer.from(`${cfg.nwmsBasicUser}:${cfg.nwmsBasicPass}`).toString("base64");
    return {
        "Content-Type": "application/json",
        Authorization: `Basic ${basic}`,
        AuthToken: cfg.nwmsAuthToken,
    };
}

function toJalali(dateStr) {
    if (!dateStr) return "";
    try {
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return "";
        const parts = new Intl.DateTimeFormat("fa-IR-u-nu-latn", {
            year: "numeric", month: "2-digit", day: "2-digit",
        }).format(d).split("/");
        return parts.join("/");
    } catch { return ""; }
}

/**
 * plate_number in our DB: "left2-mid3-letter-right2" e.g. "88-999-پ-66"
 * NWMS format: "right2|letter|mid3|left2" e.g. "66|پ|999|88"
 */
function formatPlateForNwms(plateStr) {
    if (!plateStr) return "";
    const parts = String(plateStr).split("-");
    if (parts.length !== 4) return plateStr;
    const [left2, mid3, letter, right2] = parts;
    return `${right2}|${letter}|${mid3}|${left2}`;
}

/**
 * plate from receipts: separate columns
 * NWMS format: "right2|letter|mid3|left2"
 */
function formatPlateFromColumns(left2, mid3, letter, right2) {
    if (!left2 && !mid3 && !letter && !right2) return "";
    return `${right2 || ""}|${letter || ""}|${mid3 || ""}|${left2 || ""}`;
}

const MEASURE_MAP = {
    "کیلوگرم": "1", "kg": "1", "kilogram": "1",
    "تن": "2", "ton": "2",
    "لیتر": "3", "litre": "3", "liter": "3",
    "متر": "4", "meter": "4",
    "مترمربع": "5", "m2": "5",
    "تعداد": "6", "عدد": "6", "piece": "6", "pcs": "6",
    "گرم": "20", "gram": "20",
};

function mapMeasurementUnit(unitName, nwmsUnit) {
    if (nwmsUnit) return nwmsUnit;
    const key = String(unitName || "").toLowerCase().trim();
    return MEASURE_MAP[key] || "6";
}

// ──────────────────────────────────────────────
//  رسید ما  →  رسید سامانه جامع (Receipt)
// ──────────────────────────────────────────────
async function sendReceiptToNwms(memberId, receiptId) {
    const cfg = await getNwmsConfig(memberId);
    if (!cfg) throw new Error("تنظیمات سامانه جامع انبار تکمیل نشده است. به بخش تنظیمات > یکپارچه‌سازی مراجعه کنید.");

    const { rows: [receipt] } = await pool.query(`
        SELECT r.*, c.name AS owner_name, c.national_id AS owner_nid
        FROM receipts r
        LEFT JOIN customers c ON c.id = r.owner_id
        WHERE r.id = $1 AND r.member_id = $2
    `, [receiptId, memberId]);
    if (!receipt) throw new Error("رسید یافت نشد.");
    if (receipt.nwms_id) throw new Error(`این رسید قبلاً با کد رهگیری ${receipt.nwms_id} ارسال شده است.`);

    const { rows: items } = await pool.query(`
        SELECT ri.*, p.name AS product_name, p.nwms_good_id, p.nwms_measurement_unit, p.nwms_production_type,
               u.name AS unit_name
        FROM receipt_items ri
        LEFT JOIN products p ON p.id = ri.product_id
        LEFT JOIN product_units u ON u.id = p.unit_id
        WHERE ri.receipt_id = $1
    `, [receiptId]);

    for (const it of items) {
        if (!it.nwms_good_id) throw new Error(`کالای "${it.product_name}" کد سامانه جامع (شناسه کالا) ندارد. ابتدا در تعریف کالا، فیلد "کد سامانه جامع" را پر کنید.`);
    }

    const receiptItems = items.map(it => ({
        cid_code: it.nwms_good_id,
        measurement_unit: mapMeasurementUnit(it.unit_name, it.nwms_measurement_unit),
        production_type: it.nwms_production_type || "1",
        count: Number(it.count) || 0,
        gross_weight: Number(it.weights_full) || undefined,
        net_weight: Number(it.weights_net) || undefined,
        goods_description: it.product_name || "",
    }));

    const totalNet = items.reduce((s, i) => s + (Number(i.weights_net) || 0), 0);
    const totalGross = items.reduce((s, i) => s + (Number(i.weights_full) || 0), 0);

    const body = {
        number: String(receipt.receipt_no),
        rcp_date: toJalali(receipt.doc_date),
        warehouse_id: cfg.nwmsWarehouseId || undefined,
        contractor_national_id: cfg.nwmsContractorNationalId || undefined,
        postal_code: cfg.nwmsPostalCode || undefined,
        owner: receipt.owner_nid || undefined,
        driver_national_id: receipt.driver_national_id || undefined,
        vehicle_number: formatPlateFromColumns(receipt.plate_left2, receipt.plate_mid3, receipt.plate_letter, receipt.plate_iran_right) || undefined,
        vehicle_type: "1",
        vehicle_number_type: "1",
        net_weight: totalNet || undefined,
        gross_weight: totalGross || undefined,
        description: `رسید شماره ${receipt.receipt_no}`,
        discharge_date: toJalali(receipt.discharge_date) || undefined,
        receipt_items: receiptItems,
    };

    Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);

    const resp = await axios.post(`${NWMS_BASE}/PublicNWMSReceiptPermanent`, body, {
        headers: buildAuthHeaders(cfg), proxy: false, timeout: 30000,
    });

    const data = resp.data;
    if (data.error_code && data.error_code !== 0) {
        throw new Error(`خطای سامانه جامع: [${data.error_code}] ${data.error_message || ""}`);
    }

    const nwmsId = data.id;
    await pool.query(`UPDATE receipts SET nwms_id = $1, nwms_status = 'sent' WHERE id = $2`, [nwmsId, receiptId]);
    return { nwmsId, data };
}

// ──────────────────────────────────────────────
//  خروجی ما  →  حواله سامانه جامع (Draft)
// ──────────────────────────────────────────────
async function sendExitToNwms(memberId, exitId) {
    const cfg = await getNwmsConfig(memberId);
    if (!cfg) throw new Error("تنظیمات سامانه جامع انبار تکمیل نشده است. به بخش تنظیمات > یکپارچه‌سازی مراجعه کنید.");

    const { rows: [exit] } = await pool.query(`
        SELECT we.*, cust.name AS owner_name, cust.national_id AS owner_nid
        FROM warehouse_exits we
        LEFT JOIN customers cust ON cust.id = we.owner_id
        WHERE we.id = $1 AND we.member_id = $2
    `, [exitId, memberId]);
    if (!exit) throw new Error("خروجی یافت نشد.");
    if (exit.nwms_id) throw new Error(`این خروجی قبلاً با کد رهگیری ${exit.nwms_id} ارسال شده است.`);

    const { rows: exitItems } = await pool.query(`
        SELECT wei.*, loi.product_id, loi.batch_no,
               p.name AS product_name, p.nwms_good_id, p.nwms_measurement_unit, p.nwms_production_type,
               u.name AS unit_name
        FROM warehouse_exit_items wei
        LEFT JOIN loading_order_items loi ON loi.id = wei.loading_item_id
        LEFT JOIN products p ON p.id = loi.product_id
        LEFT JOIN product_units u ON u.id = p.unit_id
        WHERE wei.warehouse_exit_id = $1
    `, [exitId]);

    for (const it of exitItems) {
        if (!it.nwms_good_id) throw new Error(`کالای "${it.product_name}" کد سامانه جامع (شناسه کالا) ندارد. ابتدا در تعریف کالا، فیلد "کد سامانه جامع" را پر کنید.`);
    }

    const draftItems = exitItems.map(it => ({
        cid_code: it.nwms_good_id,
        measurement_unit: mapMeasurementUnit(it.unit_name, it.nwms_measurement_unit),
        production_type: it.nwms_production_type || "1",
        count: Number(it.qty) || Number(it.weight_net) || 0,
        gross_weight: Number(it.weight_full) || undefined,
        net_weight: Number(it.weight_net) || undefined,
        goods_description: it.product_name || "",
    }));

    const totalNet = exitItems.reduce((s, i) => s + (Number(i.weight_net) || 0), 0);
    const totalGross = exitItems.reduce((s, i) => s + (Number(i.weight_full) || 0), 0);

    const body = {
        number: String(exit.exit_no),
        goods_issue_date: toJalali(exit.exit_date),
        warehouse_id: cfg.nwmsWarehouseId || undefined,
        contractor_national_id: cfg.nwmsContractorNationalId || undefined,
        postal_code: cfg.nwmsPostalCode || undefined,
        owner: exit.owner_nid || undefined,
        driver_national_id: exit.driver_national_code || undefined,
        vehicle_number: formatPlateForNwms(exit.plate_number) || undefined,
        vehicle_type: "1",
        vehicle_number_type: "1",
        net_weight: totalNet || undefined,
        gross_weight: totalGross || undefined,
        description: `خروجی شماره ${exit.exit_no}`,
        goods_issue_items: draftItems,
    };

    Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);

    const resp = await axios.post(`${NWMS_BASE}/PublicNWMSDraftPermanent`, body, {
        headers: buildAuthHeaders(cfg), proxy: false, timeout: 30000,
    });

    const data = resp.data;
    if (data.error_code && data.error_code !== 0) {
        throw new Error(`خطای سامانه جامع: [${data.error_code}] ${data.error_message || ""}`);
    }

    const nwmsId = data.id;
    await pool.query(`UPDATE warehouse_exits SET nwms_id = $1, nwms_status = 'sent' WHERE id = $2`, [nwmsId, exitId]);
    return { nwmsId, data };
}

// ──────────────────────────────────────────────
//  ابطال رسید در سامانه جامع
// ──────────────────────────────────────────────
async function revokeReceiptNwms(memberId, receiptId) {
    const cfg = await getNwmsConfig(memberId);
    if (!cfg) throw new Error("تنظیمات سامانه جامع تکمیل نشده.");

    const { rows: [r] } = await pool.query(`SELECT nwms_id FROM receipts WHERE id=$1 AND member_id=$2`, [receiptId, memberId]);
    if (!r?.nwms_id) throw new Error("این رسید در سامانه جامع ثبت نشده.");

    const resp = await axios.post(`${NWMS_BASE}/PublicNWMSReceiptRevoke/${r.nwms_id}`, {}, {
        headers: buildAuthHeaders(cfg), proxy: false, timeout: 30000,
    });
    const data = resp.data;
    if (data.error_code && data.error_code !== 0) {
        throw new Error(`خطای ابطال: [${data.error_code}] ${data.error_message || ""}`);
    }
    await pool.query(`UPDATE receipts SET nwms_status = 'revoked' WHERE id = $1`, [receiptId]);
    return data;
}

// ──────────────────────────────────────────────
//  ابطال خروجی (حواله) در سامانه جامع
// ──────────────────────────────────────────────
async function revokeExitNwms(memberId, exitId) {
    const cfg = await getNwmsConfig(memberId);
    if (!cfg) throw new Error("تنظیمات سامانه جامع تکمیل نشده.");

    const { rows: [e] } = await pool.query(`SELECT nwms_id FROM warehouse_exits WHERE id=$1 AND member_id=$2`, [exitId, memberId]);
    if (!e?.nwms_id) throw new Error("این خروجی در سامانه جامع ثبت نشده.");

    const resp = await axios.post(`${NWMS_BASE}/PublicNWMSDraftRevoke/${e.nwms_id}`, {}, {
        headers: buildAuthHeaders(cfg), proxy: false, timeout: 30000,
    });
    const data = resp.data;
    if (data.error_code && data.error_code !== 0) {
        throw new Error(`خطای ابطال: [${data.error_code}] ${data.error_message || ""}`);
    }
    await pool.query(`UPDATE warehouse_exits SET nwms_status = 'revoked' WHERE id = $1`, [exitId]);
    return data;
}

// ──────────────────────────────────────────────
//  دریافت لیست واحدهای بهره‌بردار
// ──────────────────────────────────────────────
async function getNwmsWarehouses(memberId) {
    const cfg = await getNwmsConfig(memberId);
    if (!cfg) throw new Error("تنظیمات سامانه جامع تکمیل نشده.");

    const resp = await axios.get(`${NWMS_BASE}/PublicNWMSGetUserWarehouse`, {
        headers: buildAuthHeaders(cfg), proxy: false, timeout: 15000,
    });
    return resp.data;
}

module.exports = { sendReceiptToNwms, sendExitToNwms, revokeReceiptNwms, revokeExitNwms, getNwmsWarehouses, getNwmsConfig };
