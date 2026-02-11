// api/clearanceItems.js
const express = require("express");
const { supabaseAdmin } = require("../supabaseAdmin");
const authMiddleware = require("./middleware/auth");

const router = express.Router();

/* ============================================================
   Helpers
============================================================ */
function toNumber(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function uniq(arr) {
    return [...new Set((arr || []).filter((x) => x !== null && x !== undefined))];
}

// ساخت OR برای eq:  col.eq.1,col.eq.2,...
function orEqList(col, ids) {
    const clean = uniq(ids).map((x) => toNumber(x)).filter((x) => Number.isFinite(x));
    if (!clean.length) return null;
    return clean.map((id) => `${col}.eq.${id}`).join(",");
}

/* ============================================================
   UUID -> bigint member_id
============================================================ */
async function getNumericMemberId(idInput) {
    if (!idInput) return null;

    if (!isNaN(idInput) && !String(idInput).includes("-")) return Number(idInput);

    const { data, error } = await supabaseAdmin
        .from("members")
        .select("id")
        .eq("auth_user_id", idInput)
        .maybeSingle();

    if (error) {
        console.error("❌ Database Error in getNumericMemberId:", error.message);
        return null;
    }
    return data ? Number(data.id) : null;
}

/* ============================================================
   دریافت موجودی یک batch از روی receipt_items + inventory_transactions
   parentRowCode همان row_code در receipt_items است
============================================================ */
async function getBatchAvailability({ member_id, owner_id, parentRowCode }) {
    // 1) receipts متعلق به این owner/member
    const { data: receipts, error: recErr } = await supabaseAdmin
        .from("receipts")
        .select("id")
        .eq("owner_id", owner_id)
        .eq("member_id", member_id);

    if (recErr) throw new Error(recErr.message);

    const receiptIds = uniq((receipts || []).map((r) => r.id));
    if (!receiptIds.length) return null;

    // 2) receipt_item مادر: با row_code + receipt_id های بالا
    const orReceipt = orEqList("receipt_id", receiptIds);
    let parentQ = supabaseAdmin
        .from("receipt_items")
        .select("id, receipt_id, product_id, row_code, count, weights_net")
        .eq("row_code", parentRowCode);

    if (orReceipt) parentQ = parentQ.or(orReceipt);

    const { data: parentRows, error: pErr } = await parentQ.limit(1);
    if (pErr) throw new Error(pErr.message);

    if (!parentRows || !parentRows.length) return null;

    const parent = parentRows[0];
    const product_id = toNumber(parent.product_id);

    // موجودی اولیه از receipt_item
    let qty = toNumber(parent.count);
    let weight = toNumber(parent.weights_net);

    // 3) تراکنش‌ها برای همین owner/member/product که batch_no مرتبط دارند
    // توجه: Adapter شما like/ilike ندارد، پس کل tx های این محصول را می‌گیریم و در Node فیلتر می‌کنیم
    const { data: txs, error: txErr } = await supabaseAdmin
        .from("inventory_transactions")
        .select("id, qty, weight, batch_no, parent_batch_no, ref_type, ref_id, created_at")
        .eq("member_id", member_id)
        .eq("owner_id", owner_id)
        .eq("product_id", product_id);

    if (txErr) throw new Error(txErr.message);

    const batchName = parentRowCode;

    const relatedTx = (txs || []).filter((tx) => {
        const b = tx.batch_no ? String(tx.batch_no) : "";
        // این batch یا بچه‌های آن
        return b === batchName || b.startsWith(batchName + "/");
    });

    relatedTx.forEach((tx) => {
        qty += toNumber(tx.qty);
        weight += toNumber(tx.weight);
    });

    return {
        parent,
        product_id,
        qty_available: qty,
        weight_available: weight,
    };
}

/* ============================================================
   CREATE ITEM
============================================================ */
router.post("/", authMiddleware, async (req, res) => {
    try {
        let member_id = await getNumericMemberId(req.user.id);
        if (!member_id) member_id = 2; // fallback

        const { clearance_id, parentRowCode, qty, weight } = req.body;

        if (!clearance_id || !parentRowCode) {
            return res.status(400).json({ success: false, error: "clearance_id و parentRowCode الزامی است" });
        }

        const reqQty = toNumber(qty, NaN);
        const reqWeight = toNumber(weight, NaN);

        if (!Number.isFinite(reqQty) || reqQty <= 0) {
            return res.status(400).json({ success: false, error: "qty نامعتبر است" });
        }
        if (!Number.isFinite(reqWeight) || reqWeight < 0) {
            return res.status(400).json({ success: false, error: "weight نامعتبر است" });
        }

        // 0) خود clearance را می‌گیریم تا owner_id را بفهمیم (در سیستم شما owner همان customer_id است)
        const { data: clearance, error: cErr } = await supabaseAdmin
            .from("clearances")
            .select("id, member_id, customer_id")
            .eq("id", clearance_id)
            .eq("member_id", member_id)
            .single();

        if (cErr || !clearance) {
            return res.status(404).json({ success: false, error: "ترخیص یافت نشد یا دسترسی ندارید" });
        }

        const owner_id = toNumber(clearance.customer_id);
        if (!owner_id) {
            return res.status(400).json({ success: false, error: "customer_id برای ترخیص معتبر نیست" });
        }

        // 1) یافتن ردیف مادر + موجودی
        const availability = await getBatchAvailability({ member_id, owner_id, parentRowCode });
        if (!availability) {
            return res.status(404).json({ success: false, error: `ردیف ${parentRowCode} یافت نشد` });
        }

        const { parent, product_id, qty_available, weight_available } = availability;

        // 2) Validation
        if (reqQty > qty_available) {
            return res.status(400).json({
                success: false,
                error: `تعداد درخواستی (${reqQty}) بیشتر از موجودی (${qty_available}) است`,
            });
        }

        if (reqWeight > weight_available) {
            return res.status(400).json({
                success: false,
                error: `وزن درخواستی (${reqWeight}) بیشتر از موجودی (${weight_available}) است`,
            });
        }

        // 3) تولید new_row_code (بزرگترین child را پیدا کن)
        const { data: children, error: chErr } = await supabaseAdmin
            .from("clearance_items")
            .select("new_row_code")
            .eq("clearance_id", clearance_id)
            .eq("parent_row_code", parentRowCode)
            .order("new_row_code", { ascending: false })
            .limit(1);

        if (chErr) throw new Error(chErr.message);

        let nextChildNumber = 1;
        if (children && children.length > 0 && children[0]?.new_row_code) {
            const parts = String(children[0].new_row_code).split("/");
            const lastNum = parseInt(parts[1] || "0", 10);
            nextChildNumber = Number.isFinite(lastNum) ? lastNum + 1 : 1;
        }

        const newRowCode = `${parentRowCode}/${nextChildNumber}`;

        // 4) INSERT clearance_items
        const insertPayload = {
            clearance_id,
            parent_row_code: parentRowCode,
            new_row_code: newRowCode,

            // از parent receipt_item
            product_id,
            owner_id,

            // snapshot برای UI
            available_qty: qty_available,
            available_weight: weight_available,

            qty: reqQty,
            weight: reqWeight,

            // اگر ستون‌ها را دارید، می‌توانیم ست کنیم (در غیر این صورت حذف کنید)
            // batch_no: newRowCode,
            // parent_batch_no: parentRowCode,
            status: "issued",
        };

        const { data: inserted, error: insErr } = await supabaseAdmin
            .from("clearance_items")
            .insert(insertPayload)
            .select()
            .single();

        if (insErr) return res.status(400).json({ success: false, error: insErr.message });

        // 5) (توصیه شده) ثبت تراکنش منفی برای کسر موجودی همان لحظه
        // اگر این مرحله را نمی‌خواهی، این بلاک را حذف کن.
        const { error: txErr } = await supabaseAdmin
            .from("inventory_transactions")
            .insert({
                member_id,
                owner_id,
                product_id,
                qty: -Math.abs(reqQty),
                weight: -Math.abs(reqWeight),
                batch_no: newRowCode,
                parent_batch_no: parentRowCode,
                ref_type: "clearance_item",
                ref_id: inserted.id,
                created_at: new Date().toISOString(),
            });

        if (txErr) {
            // آیتم ساخته شده ولی کسر موجودی خطا خورده
            // می‌تونی اینجا rollback هم بکنی؛ فعلاً شفاف پیام می‌دهیم
            return res.status(500).json({
                success: false,
                error: "آیتم ترخیص ثبت شد اما ثبت تراکنش موجودی ناموفق بود",
                item: inserted,
                details: txErr.message,
            });
        }

        return res.json({ success: true, item: inserted });
    } catch (err) {
        console.error("❌ Clearance Item Error:", err?.message || err);
        return res.status(500).json({ success: false, error: err?.message || "Internal server error" });
    }
});

module.exports = router;
