// api/products.js
const express = require("express");
const { supabaseAdmin } = require("../supabaseAdmin");
const authMiddleware = require("./middleware/auth");

const router = express.Router();

/* ============================================================
   GET ALL PRODUCTS (فقط محصولات خود کاربر) 🔒
============================================================ */
router.get("/", authMiddleware, async (req, res) => {
    try {
        console.log("\n🔍 --- GET PRODUCTS ---");

        const member_id = req.user.id;

        console.log(`👤 Member ID: ${member_id}`);
        console.log(`📋 Query Params:`, req.query);

        const {
            limit = 500,
            offset = 0,
            search,
            category_id,
            is_active
        } = req.query;

        // ساخت کوئری با فیلتر تنانت
        let query = supabaseAdmin
            .from("products")
            .select(`
                *,
                category:product_categories(id, name),
                unit:product_units(id, name)
            `, { count: "exact" })
            .eq("member_id", member_id) // 🔒 فیلتر اجباری تنانت
            .order("created_at", { ascending: false });

        // فیلتر جستجو
        if (search) {
            query = query.or(`name.ilike.%${search}%,sku.ilike.%${search}%,code.ilike.%${search}%`);
        }

        // فیلتر دسته‌بندی
        if (category_id) {
            query = query.eq("category_id", category_id);
        }

        // فیلتر وضعیت فعال/غیرفعال
        if (is_active !== undefined) {
            query = query.eq("is_active", is_active === "true");
        }

        // صفحه‌بندی
        query = query.range(Number(offset), Number(offset) + Number(limit) - 1);

        const { data, error, count } = await query;

        if (error) {
            console.error("❌ DB Error:", error);
            throw error;
        }

        console.log(`✅ Found ${data?.length || 0} products (Total: ${count})`);

        // چک امنیتی
        if (data && data.length > 0) {
            const sample = data[0];
            if (String(sample.member_id) !== String(member_id)) {
                console.error("😱 SECURITY BREACH! Wrong member data!");
                return res.status(500).json({
                    success: false,
                    error: "Security error"
                });
            }
            console.log(`🔒 Security Check: ✅ All products belong to member ${member_id}`);
        }

        return res.json({
            success: true,
            data: data || [],
            total: count,
            limit: Number(limit),
            offset: Number(offset)
        });

    } catch (e) {
        console.error("❌ Get Products Error:", e.message);
        return res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

/* ============================================================
   GET ONE PRODUCT (فقط مال خود کاربر) 🔒
============================================================ */
router.get("/:id", authMiddleware, async (req, res) => {
    try {
        const product_id = req.params.id;
        const member_id = req.user.id;

        console.log(`🔍 Getting product ${product_id} for member ${member_id}`);

        const { data, error } = await supabaseAdmin
            .from("products")
            .select(`
                *,
                category:product_categories(id, name),
                unit:product_units(id, name)
            `)
            .eq("id", product_id)
            .eq("member_id", member_id) // 🔒 فیلتر تنانت
            .single();

        if (error || !data) {
            console.error("❌ Product not found:", error);
            return res.status(404).json({
                success: false,
                error: "محصول یافت نشد یا دسترسی ندارید"
            });
        }

        console.log(`✅ Product found: ${data.name}`);

        return res.json({
            success: true,
            data
        });

    } catch (e) {
        console.error("❌ Get Product Error:", e);
        return res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

/* ============================================================
   CREATE PRODUCT (ثبت خودکار به نام کاربر) 🔒
============================================================ */
router.post("/", authMiddleware, async (req, res) => {
    try {
        const member_id = req.user.id;

        console.log("📦 Creating Product for Member:", member_id);
        console.log("📋 Product Data:", req.body);

        // 🔒 تزریق خودکار member_id
        const payload = {
            ...req.body,
            member_id
        };

        // حذف فیلدهای خطرناک
        delete payload.id;
        delete payload.created_at;
        delete payload.updated_at;

        // اعتبارسنجی
        if (!payload.name) {
            return res.status(400).json({
                success: false,
                error: "نام محصول الزامی است"
            });
        }

        if (!payload.category_id) {
            return res.status(400).json({
                success: false,
                error: "دسته‌بندی الزامی است"
            });
        }

        if (!payload.unit_id) {
            return res.status(400).json({
                success: false,
                error: "واحد شمارش الزامی است"
            });
        }

        const { data, error } = await supabaseAdmin
            .from("products")
            .insert([payload])
            .select(`
                *,
                category:product_categories(id, name),
                unit:product_units(id, name)
            `)
            .single();

        if (error) {
            console.error("❌ Insert Error:", error);

            if (error.code === '23505') {
                return res.status(409).json({
                    success: false,
                    error: "کد محصول (SKU) تکراری است"
                });
            }

            if (error.code === '23503') {
                return res.status(400).json({
                    success: false,
                    error: "دسته‌بندی یا واحد شمارش نامعتبر است"
                });
            }

            return res.status(400).json({
                success: false,
                error: error.message
            });
        }

        console.log(`✅ Product Created: ID=${data.id}, Name=${data.name}`);

        return res.json({
            success: true,
            data,
            message: "محصول با موفقیت ایجاد شد"
        });

    } catch (e) {
        console.error("❌ Create Product Error:", e);
        return res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

/* ============================================================
   UPDATE PRODUCT (فقط مال خود کاربر) 🔒
============================================================ */
router.put("/:id", authMiddleware, async (req, res) => {
    try {
        const product_id = req.params.id;
        const member_id = req.user.id;

        console.log(`✏️ Updating product ${product_id} for member ${member_id}`);

        // حذف فیلدهای خطرناک
        const payload = { ...req.body };
        delete payload.id;
        delete payload.member_id; // ⚠️ جلوگیری از تغییر مالکیت
        delete payload.created_at;
        delete payload.updated_at;

        const { data, error } = await supabaseAdmin
            .from("products")
            .update(payload)
            .eq("id", product_id)
            .eq("member_id", member_id) // 🔒 فقط صاحب محصول
            .select(`
                *,
                category:product_categories(id, name),
                unit:product_units(id, name)
            `)
            .single();

        if (error) {
            console.error("❌ Update Error:", error);

            if (error.code === '23505') {
                return res.status(409).json({
                    success: false,
                    error: "کد محصول (SKU) تکراری است"
                });
            }

            return res.status(400).json({
                success: false,
                error: error.message
            });
        }

        if (!data) {
            return res.status(404).json({
                success: false,
                error: "محصول یافت نشد یا اجازه ویرایش ندارید"
            });
        }

        console.log(`✅ Product Updated: ${data.name}`);

        return res.json({
            success: true,
            data,
            message: "محصول با موفقیت ویرایش شد"
        });

    } catch (e) {
        console.error("❌ Update Product Error:", e);
        return res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

/* ============================================================
   DELETE PRODUCT (فقط مال خود کاربر) 🔒
============================================================ */
router.delete("/:id", authMiddleware, async (req, res) => {
    try {
        const product_id = req.params.id;
        const member_id = req.user.id;

        console.log(`🗑️ Deleting product ${product_id} for member ${member_id}`);

        const { error } = await supabaseAdmin
            .from("products")
            .delete()
            .eq("id", product_id)
            .eq("member_id", member_id); // 🔒 فقط صاحب محصول

        if (error) {
            console.error("❌ Delete Error:", error);

            if (error.code === "23503") {
                return res.status(409).json({
                    success: false,
                    error: "امکان حذف وجود ندارد",
                    message: "این محصول در اسناد انبار استفاده شده است"
                });
            }

            return res.status(400).json({
                success: false,
                error: error.message
            });
        }

        console.log(`✅ Product Deleted: ID=${product_id}`);

        return res.json({
            success: true,
            message: "محصول با موفقیت حذف شد"
        });

    } catch (e) {
        console.error("❌ Delete Product Error:", e);
        return res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

module.exports = router;