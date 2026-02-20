const express = require("express");
const authMiddleware = require("./middleware/auth");
const { requireSuperAdmin } = require("./middleware/auth");
const { pool } = require("../supabaseAdmin");
const router = express.Router();

const SUPER_ADMIN_ROLES = new Set(["super_admin", "superadmin", "admin", "owner", "root", "system_admin"]);

const isUUID = (str) => str && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

function normalizeCategory(body = {}) {
    return {
        name: body.name?.trim() || null,
        slug: body.slug?.trim() || null,
        parent_id: (body.parent_id && isUUID(body.parent_id)) ? body.parent_id : null,
        description: body.description ?? "",
        image_id: (body.image_id && isUUID(body.image_id)) ? body.image_id : null,
        is_active: body.is_active !== false,
        sort_order: Number(body.sort_order) || 0,
        storage_cost: Number(body.storage_cost) || 0,
        loading_cost: Number(body.loading_cost) || 0,
        calc_method: body.calc_method === 'qty' ? 'qty' : 'weight',
    };
}

router.get("/", authMiddleware, async (req, res) => {
    try {
        const memberId = req.user.member_id || req.user.id;
        const isSuperAdmin = SUPER_ADMIN_ROLES.has((req.user.role || "").toLowerCase());
        const { limit: limitRaw = 500, search, parent_id, is_active } = req.query;
        const limit = Math.min(Math.max(parseInt(limitRaw, 10) || 500, 1), 2000);

        const params = [];
        let where = "WHERE 1=1";
        let idx = 1;

        params.push(memberId);
        where += ` AND (c.member_id IS NULL OR c.member_id = $${idx++})`;

        if (search && String(search).trim()) {
            params.push(`%${String(search).trim()}%`);
            where += ` AND c.name ILIKE $${idx++}`;
        }
        if (parent_id && isUUID(parent_id)) {
            params.push(parent_id);
            where += ` AND c.parent_id = $${idx++}`;
        }
        if (is_active !== undefined) {
            params.push(is_active === 'true');
            where += ` AND c.is_active = $${idx++}`;
        }

        params.push(limit);

        const dataSql = `
            SELECT c.*,
                   p.name AS parent_name,
                   p.storage_cost AS parent_storage_cost,
                   p.loading_cost AS parent_loading_cost,
                   p.calc_method AS parent_calc_method
            FROM public.product_categories c
            LEFT JOIN public.product_categories p ON p.id = c.parent_id
            ${where}
            ORDER BY c.sort_order ASC, c.created_at DESC
            LIMIT $${idx}
        `;

        const { rows } = await pool.query(dataSql, params);
        res.json({ success: true, data: rows || [], count: rows.length });
    } catch (e) {
        console.error("GET Categories Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get("/:id", authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        if (!isUUID(id)) return res.status(400).json({ success: false, error: "شناسه نامعتبر" });

        const sql = `SELECT c.*, p.name AS parent_name FROM public.product_categories c
                      LEFT JOIN public.product_categories p ON p.id = c.parent_id WHERE c.id = $1 LIMIT 1`;
        const { rows } = await pool.query(sql, [id]);
        if (!rows.length) return res.status(404).json({ success: false, error: "یافت نشد" });
        res.json({ success: true, data: rows[0] });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post("/", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const memberId = req.user.member_id || req.user.id;
        const isSuperAdmin = SUPER_ADMIN_ROLES.has((req.user.role || "").toLowerCase());
        const payload = normalizeCategory(req.body);

        if (!payload.name) return res.status(400).json({ success: false, error: "نام دسته‌بندی الزامی است" });

        if (!payload.slug) {
            payload.slug = payload.name.toLowerCase().replace(/\s+/g, '-').replace(/[^\w\-]+/g, '').replace(/--+/g, '-')
                || 'cat-' + Date.now();
        }

        if (!isSuperAdmin && !payload.parent_id) {
            return res.status(403).json({ success: false, error: "فقط سوپرادمین می‌تواند دسته اصلی ایجاد کند. شما فقط می‌توانید زیردسته اضافه کنید." });
        }

        let memberIdVal = null;
        if (!isSuperAdmin) {
            memberIdVal = memberId;
            if (payload.parent_id) {
                const { rows: parentRows } = await client.query(
                    "SELECT storage_cost, loading_cost, calc_method FROM product_categories WHERE id = $1",
                    [payload.parent_id]
                );
                if (parentRows.length) {
                    payload.storage_cost = Number(parentRows[0].storage_cost) || 0;
                    payload.loading_cost = Number(parentRows[0].loading_cost) || 0;
                    payload.calc_method = parentRows[0].calc_method || 'weight';
                }
            }
        }

        await client.query("BEGIN");

        const sql = `
            INSERT INTO public.product_categories (
                name, slug, parent_id, description, image_id,
                is_active, sort_order, storage_cost, loading_cost, calc_method,
                member_id, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
            RETURNING *
        `;
        const r = await client.query(sql, [
            payload.name, payload.slug, payload.parent_id, payload.description,
            payload.image_id, payload.is_active, payload.sort_order,
            payload.storage_cost, payload.loading_cost, payload.calc_method,
            memberIdVal
        ]);
        await client.query("COMMIT");
        res.json({ success: true, data: r.rows[0], message: "دسته‌بندی ایجاد شد" });
    } catch (e) {
        await client.query("ROLLBACK");
        console.error("CREATE Category Error:", e);
        if (e.code === "23505") return res.status(409).json({ success: false, error: "نام دسته تکراری است" });
        res.status(500).json({ success: false, error: e.message });
    } finally { client.release(); }
});

router.put("/:id", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        if (!isUUID(id)) return res.status(400).json({ success: false, error: "شناسه نامعتبر" });

        const memberId = req.user.member_id || req.user.id;
        const isSuperAdmin = SUPER_ADMIN_ROLES.has((req.user.role || "").toLowerCase());

        const { rows: existing } = await client.query("SELECT * FROM product_categories WHERE id = $1", [id]);
        if (!existing.length) return res.status(404).json({ success: false, error: "یافت نشد" });

        if (!isSuperAdmin && existing[0].member_id !== memberId) {
            return res.status(403).json({ success: false, error: "شما فقط می‌توانید دسته‌بندی‌های خودتان را ویرایش کنید" });
        }

        const payload = normalizeCategory(req.body);
        if (!payload.name) return res.status(400).json({ success: false, error: "نام دسته‌بندی الزامی است" });

        if (!isSuperAdmin && existing[0].member_id) {
            payload.storage_cost = Number(existing[0].storage_cost) || 0;
            payload.loading_cost = Number(existing[0].loading_cost) || 0;
            payload.calc_method = existing[0].calc_method || 'weight';
        }

        await client.query("BEGIN");

        const sql = `
            UPDATE public.product_categories
            SET name=$1, slug=$2, parent_id=$3, description=$4, image_id=$5,
                is_active=$6, sort_order=$7, storage_cost=$8, loading_cost=$9, calc_method=$10, updated_at=NOW()
            WHERE id=$11
            RETURNING *
        `;
        const r = await client.query(sql, [
            payload.name, payload.slug, payload.parent_id, payload.description, payload.image_id,
            payload.is_active, payload.sort_order, payload.storage_cost, payload.loading_cost, payload.calc_method,
            id
        ]);

        if (!r.rows.length) {
            await client.query("ROLLBACK");
            return res.status(404).json({ success: false, error: "یافت نشد" });
        }
        await client.query("COMMIT");
        res.json({ success: true, data: r.rows[0], message: "بروزرسانی شد" });
    } catch (e) {
        await client.query("ROLLBACK");
        res.status(500).json({ success: false, error: e.message });
    } finally { client.release(); }
});

router.delete("/:id", authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        if (!isUUID(id)) return res.status(400).json({ success: false, error: "شناسه نامعتبر" });

        const memberId = req.user.member_id || req.user.id;
        const isSuperAdmin = SUPER_ADMIN_ROLES.has((req.user.role || "").toLowerCase());

        const { rows } = await pool.query("SELECT member_id FROM product_categories WHERE id = $1", [id]);
        if (!rows.length) return res.status(404).json({ success: false, error: "یافت نشد" });

        if (!isSuperAdmin && rows[0].member_id !== memberId) {
            return res.status(403).json({ success: false, error: "شما فقط می‌توانید دسته‌بندی‌های خودتان را حذف کنید" });
        }

        await pool.query(`DELETE FROM public.product_categories WHERE id=$1`, [id]);
        res.json({ success: true, message: "حذف شد" });
    } catch (e) {
        if (e.code === "23503") return res.status(409).json({ success: false, error: "این دسته فرزند یا کالای وابسته دارد و قابل حذف نیست" });
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
