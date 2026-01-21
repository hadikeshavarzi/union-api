// api/treasury/checkbooks.js
const express = require("express");
const { supabaseAdmin } = require("../../supabaseAdmin");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

/* GET ALL CHECKBOOKS */
router.get("/", authMiddleware, async (req, res) => {
    try {
        const { status, bank_id } = req.query;
        const member_id = req.user.id;

        let query = supabaseAdmin
            .from("treasury_checkbooks")
            .select(`
                *,
                treasury_banks(id, bank_name, account_no, branch_name)
            `)
            .eq("member_id", member_id) // ✅ فیلتر تنانت
            .order("created_at", { ascending: false });

        if (status) {
            query = query.eq("status", status);
        }

        if (bank_id) {
            query = query.eq("bank_id", bank_id);
        }

        const { data, error } = await query;

        if (error) throw error;

        return res.json({ success: true, data });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* GET ONE CHECKBOOK */
router.get("/:id", authMiddleware, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from("treasury_checkbooks")
            .select(`
                *,
                treasury_banks(id, bank_name, account_no, branch_name)
            `)
            .eq("id", req.params.id)
            .eq("member_id", req.user.id)
            .single();

        if (error || !data) {
            return res.status(404).json({
                success: false,
                error: "دسته‌چک یافت نشد یا دسترسی ندارید"
            });
        }

        return res.json({ success: true, data });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* CREATE CHECKBOOK */
router.post("/", authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.id;

        const payload = {
            ...req.body,
            member_id,
            current_serial: req.body.serial_start,
            status: 'active'
        };

        delete payload.id;
        delete payload.created_at;

        if (!payload.bank_id || !payload.serial_start || !payload.serial_end) {
            return res.status(400).json({
                success: false,
                error: "بانک و سریال شروع و پایان الزامی است"
            });
        }

        // چک اینکه bank_id متعلق به این member باشه
        const { data: bank } = await supabaseAdmin
            .from("treasury_banks")
            .select("id")
            .eq("id", payload.bank_id)
            .eq("member_id", member_id)
            .single();

        if (!bank) {
            return res.status(403).json({
                success: false,
                error: "بانک انتخابی یافت نشد یا دسترسی ندارید"
            });
        }

        const { data, error } = await supabaseAdmin
            .from("treasury_checkbooks")
            .insert([payload])
            .select()
            .single();

        if (error) throw error;

        return res.json({
            success: true,
            data,
            message: "دسته‌چک با موفقیت ایجاد شد"
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* UPDATE CHECKBOOK */
router.put("/:id", authMiddleware, async (req, res) => {
    try {
        const payload = { ...req.body };
        delete payload.id;
        delete payload.member_id;
        delete payload.created_at;

        const { data, error } = await supabaseAdmin
            .from("treasury_checkbooks")
            .update(payload)
            .eq("id", req.params.id)
            .eq("member_id", req.user.id)
            .select()
            .single();

        if (error || !data) {
            return res.status(404).json({
                success: false,
                error: "دسته‌چک یافت نشد یا دسترسی ندارید"
            });
        }

        return res.json({
            success: true,
            data,
            message: "دسته‌چک با موفقیت ویرایش شد"
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

/* DELETE CHECKBOOK */
router.delete("/:id", authMiddleware, async (req, res) => {
    try {
        const { error } = await supabaseAdmin
            .from("treasury_checkbooks")
            .delete()
            .eq("id", req.params.id)
            .eq("member_id", req.user.id);

        if (error) {
            if (error.code === '23503') {
                return res.status(409).json({
                    success: false,
                    error: "امکان حذف وجود ندارد (دسته‌چک دارای چک صادر شده)"
                });
            }
            throw error;
        }

        return res.json({
            success: true,
            message: "دسته‌چک با موفقیت حذف شد"
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;