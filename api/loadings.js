const express = require("express");
const { supabaseAdmin } = require("../supabaseAdmin");
const authMiddleware = require("./middleware/auth");

const router = express.Router();

// --- Helper: دریافت آیدی عددی ممبر ---
async function getNumericMemberId(idInput) {
    if (!idInput) return null;
    if (!isNaN(idInput) && !String(idInput).includes("-")) return Number(idInput);

    const { data } = await supabaseAdmin
        .from('members')
        .select('id')
        .eq('auth_user_id', idInput)
        .maybeSingle();
    return data ? data.id : null;
}

// --- Helper: تولید شماره سفارش (order_no) ---
async function generateOrderNo(memberId) {
    const { count } = await supabaseAdmin
        .from("loading_orders")
        .select("*", { count: "exact", head: true })
        .eq("member_id", memberId);

    // فرمول: (آیدی انبار * 1000) + سری 5000 + ردیف
    return (Number(memberId) * 1000) + 5000 + (count + 1);
}

// --- Helper: تبدیل آبجکت پلاک به رشته ---
function formatPlate(plateObj) {
    if (!plateObj) return null;
    if (typeof plateObj === 'string') return plateObj;

    const { right2, middle3, letter, left2 } = plateObj;
    if (!right2 || !middle3 || !letter || !left2) return null;
    return `${left2}-${middle3}-${letter}-${right2}`;
}

// --- 1. ثبت دستور بارگیری (POST) ---
router.post("/", authMiddleware, async (req, res) => {
    try {
        const uuidOrId = req.user.id;
        let numericId = await getNumericMemberId(uuidOrId);
        if (!numericId) numericId = 2; // Fallback

        const {
            clearance_id,
            loading_date,
            driver_name,
            plate,
            description,
            items
        } = req.body;

        const orderNo = await generateOrderNo(numericId);
        const plateString = formatPlate(plate);

        // A. ثبت هدر بارگیری
        const { data: order, error: hErr } = await supabaseAdmin
            .from("loading_orders")
            .insert({
                member_id: numericId,
                order_no: orderNo,
                clearance_id: clearance_id,
                status: 'issued',
                loading_date: loading_date || new Date().toISOString(),
                driver_name: driver_name,
                plate_number: plateString,
                description: description,
                warehouse_keeper_id: numericId
            })
            .select().single();

        if (hErr) throw hErr;

        // B. ثبت آیتم‌های بارگیری (با نام صحیح جدول شما)
        if (items && items.length > 0) {
            const formattedItems = items.map(item => ({
                loading_order_id: order.id,
                clearance_item_id: item.clearance_item_id,
                product_id: item.product_id,
                qty: Number(item.qty || 0),
                weight: Number(item.weight || 0),
                batch_no: item.batch_no || null
            }));

            // 👇 اینجا نام جدول را loading_order_items گذاشتیم (طبق دیتابیس شما)
            const { error: iErr } = await supabaseAdmin
                .from("loading_order_items")
                .insert(formattedItems);

            if (iErr) {
                // Rollback (حذف هدر در صورت خطا)
                await supabaseAdmin.from("loading_orders").delete().eq("id", order.id);
                throw iErr;
            }
        }

        return res.json({
            success: true,
            order_no: orderNo,
            message: "دستور بارگیری با موفقیت صادر شد"
        });

    } catch (e) {
        console.error("❌ Loading Order Error:", e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

// --- 2. دریافت لیست بارگیری‌ها (GET) ---
router.get("/", authMiddleware, async (req, res) => {
    try {
        let numericId = await getNumericMemberId(req.user.id);
        if (!numericId) numericId = 2;

        const { data, error } = await supabaseAdmin
            .from("loading_orders")
            .select(`
                *,
                clearance:clearances (
                    clearance_no,
                    customer:customers (name)
                ),
                items:loading_order_items ( *, product:products (name) )  -- 👈 اصلاح نام جدول در Join
            `)
            .eq("member_id", numericId)
            .order("created_at", { ascending: false });

        if (error) throw error;
        return res.json({ success: true, data });

    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;