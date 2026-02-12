const express = require("express");
const router = express.Router();
const { pool } = require("../supabaseAdmin");
const auth = require("./middleware/auth");

const MEMBER_SELECT_COLUMNS = `
    id,
    role,
    full_name,
    father_name,
    national_id,
    mobile,
    phone,
    email,
    address,
    birth_date,
    business_name,
    category,
    member_status,
    license_number,
    license_issue_date,
    license_expire_date,
    company_name,
    registration_number,
    member_code,
    permissions,
    owner_id,
    member_image,
    national_card_image,
    id_card_image,
    license_image,
    company_license_image,
    created_at,
    updated_at
`;

const UPDATE_WHITELIST = [
    "role","full_name","father_name","national_id","mobile","phone","email","address",
    "birth_date","business_name","category","member_status","license_number","license_issue_date",
    "license_expire_date","company_name","registration_number","member_code","permissions","owner_id",
    "member_image","national_card_image","id_card_image","license_image","company_license_image"
];

const nullable = (value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === "string" && value.trim() === "") return null;
    return value;
};

const pickEditableFields = (body = {}) => {
    const out = {};

    for (const key of UPDATE_WHITELIST) {
        if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
        if (key === "permissions") {
            out.permissions = Array.isArray(body.permissions) ? body.permissions : [];
            continue;
        }
        out[key] = nullable(body[key]);
    }

    return out;
};

const mapRowToPayload = (body = {}) => ({
    role: nullable(body.role) || "union_user",
    full_name: nullable(body.full_name),
    father_name: nullable(body.father_name),
    national_id: nullable(body.national_id),
    mobile: nullable(body.mobile),
    phone: nullable(body.phone),
    email: nullable(body.email),
    address: nullable(body.address),
    birth_date: nullable(body.birth_date),
    business_name: nullable(body.business_name),
    category: nullable(body.category) || "warehouse",
    member_status: nullable(body.member_status) || "active",
    license_number: nullable(body.license_number),
    license_issue_date: nullable(body.license_issue_date),
    license_expire_date: nullable(body.license_expire_date),
    company_name: nullable(body.company_name),
    registration_number: nullable(body.registration_number),
    member_code: nullable(body.member_code),
    permissions: Array.isArray(body.permissions) ? body.permissions : [],
    owner_id: nullable(body.owner_id),
    member_image: nullable(body.member_image),
    national_card_image: nullable(body.national_card_image),
    id_card_image: nullable(body.id_card_image),
    license_image: nullable(body.license_image),
    company_license_image: nullable(body.company_license_image),
});

// ==========================================
// 1) دریافت لیست اعضا یا یک عضو با query id
//    GET /api/members/list
//    GET /api/members/list?id=<member_id>
// ==========================================
router.get("/list", auth, async (req, res) => {
    try {
        const { id, member_id, user_id, search } = req.query || {};
        const values = [];
        const clauses = [];

        const targetId = String(id || member_id || user_id || "").trim();
        if (targetId) {
            values.push(targetId);
            clauses.push(`id::text = $${values.length}`);
        }

        const searchText = String(search || "").trim();
        if (searchText) {
            values.push(`%${searchText}%`);
            clauses.push(`(
                COALESCE(full_name,) ILIKE $${values.length}
                OR COALESCE(company_name,) ILIKE $${values.length}
                OR COALESCE(mobile,) ILIKE $${values.length}
                OR COALESCE(member_code,) ILIKE $${values.length}
            )`);
        }

        const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        const limitSql = targetId ? "LIMIT 1" : "";

        const r = await pool.query(
            `SELECT ${MEMBER_SELECT_COLUMNS}
             FROM public.members
             ${whereSql}
             ORDER BY created_at DESC
             ${limitSql}`,
            values
        );

        return res.json({ success: true, data: r.rows });
    } catch (e) {
        console.error("❌ Error in members/list:", e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

// ==========================================
// 2) دریافت کاربران سیستم (زیرمجموعه‌های یک مالک)
//    GET /api/members/system-users
// ==========================================
router.get("/system-users", auth, async (req, res) => {
    try {
        const ownerId = req.user.id;
        const r = await pool.query(
            `SELECT ${MEMBER_SELECT_COLUMNS}
             FROM public.members
             WHERE owner_id = $1
             ORDER BY created_at DESC`,
            [ownerId]
        );

        return res.json({ success: true, data: r.rows });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

// ==========================================
// 3) ایجاد کاربر زیرمجموعه
//    POST /api/members/system-users
// ==========================================
router.post("/system-users", auth, async (req, res) => {
    try {
        const ownerId = req.user.id;
        const body = req.body || {};

        if (!body.mobile) {
            return res.status(400).json({ success: false, error: "شماره موبایل الزامی است" });
        }
        if (!body.full_name) {
            return res.status(400).json({ success: false, error: "نام و نام خانوادگی الزامی است" });
        }

        const payload = mapRowToPayload({ ...body, owner_id: ownerId });

        const r = await pool.query(
            `INSERT INTO public.members (
                role, full_name, father_name, national_id, mobile, phone, email, address, birth_date,
                business_name, category, member_status, license_number, license_issue_date, license_expire_date,
                company_name, registration_number, member_code, permissions, owner_id,
                member_image, national_card_image, id_card_image, license_image, company_license_image,
                created_at, updated_at
            ) VALUES (
                $1,$2,$3,$4,$5,$6,$7,$8,$9,
                $10,$11,$12,$13,$14,$15,
                $16,$17,$18,$19,$20,
                $21,$22,$23,$24,$25,
                NOW(),NOW()
            )
            RETURNING ${MEMBER_SELECT_COLUMNS}`,
            [
                payload.role,
                payload.full_name,
                payload.father_name,
                payload.national_id,
                payload.mobile,
                payload.phone,
                payload.email,
                payload.address,
                payload.birth_date,
                payload.business_name,
                payload.category,
                payload.member_status,
                payload.license_number,
                payload.license_issue_date,
                payload.license_expire_date,
                payload.company_name,
                payload.registration_number,
                payload.member_code,
                payload.permissions,
                payload.owner_id,
                payload.member_image,
                payload.national_card_image,
                payload.id_card_image,
                payload.license_image,
                payload.company_license_image,
            ]
        );

        return res.json({ success: true, data: r.rows[0] });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

// ==========================================
// 4) ایجاد عضو عمومی
//    POST /api/members
// ==========================================
router.post("/", auth, async (req, res) => {
    try {
        const body = req.body || {};
        if (!body.mobile) {
            return res.status(400).json({ success: false, error: "شماره موبایل الزامی است" });
        }
        if (!body.full_name) {
            return res.status(400).json({ success: false, error: "نام و نام خانوادگی الزامی است" });
        }

        const payload = mapRowToPayload(body);

        const r = await pool.query(
            `INSERT INTO public.members (
                role, full_name, father_name, national_id, mobile, phone, email, address, birth_date,
                business_name, category, member_status, license_number, license_issue_date, license_expire_date,
                company_name, registration_number, member_code, permissions, owner_id,
                member_image, national_card_image, id_card_image, license_image, company_license_image,
                created_at, updated_at
            ) VALUES (
                $1,$2,$3,$4,$5,$6,$7,$8,$9,
                $10,$11,$12,$13,$14,$15,
                $16,$17,$18,$19,$20,
                $21,$22,$23,$24,$25,
                NOW(),NOW()
            )
            RETURNING ${MEMBER_SELECT_COLUMNS}`,
            [
                payload.role,
                payload.full_name,
                payload.father_name,
                payload.national_id,
                payload.mobile,
                payload.phone,
                payload.email,
                payload.address,
                payload.birth_date,
                payload.business_name,
                payload.category,
                payload.member_status,
                payload.license_number,
                payload.license_issue_date,
                payload.license_expire_date,
                payload.company_name,
                payload.registration_number,
                payload.member_code,
                payload.permissions,
                payload.owner_id,
                payload.member_image,
                payload.national_card_image,
                payload.id_card_image,
                payload.license_image,
                payload.company_license_image,
            ]
        );

        return res.json({ success: true, data: r.rows[0] });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

// ==========================================
// 5) دریافت عضو با شناسه
//    GET /api/members/:id
// ==========================================
router.get("/:id", auth, async (req, res) => {
    try {
        const memberId = String(req.params.id || "").trim();
        const r = await pool.query(
            `SELECT ${MEMBER_SELECT_COLUMNS}
             FROM public.members
             WHERE id::text = $1
             LIMIT 1`,
            [memberId]
        );

        if (!r.rows.length) {
            return res.status(404).json({ success: false, error: "عضو یافت نشد" });
        }

        return res.json({ success: true, data: r.rows[0] });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

// ==========================================
// 6) بروزرسانی عضو
//    PUT /api/members/:id
//    PUT /api/members/update/:id
// ==========================================
const updateMemberHandler = async (req, res) => {
    try {
        const memberId = String(req.params.id || "").trim();
        if (!memberId) {
            return res.status(400).json({ success: false, error: "شناسه عضو نامعتبر است" });
        }

        const updates = pickEditableFields(req.body || {});
        const fields = Object.keys(updates);

        if (!fields.length) {
            return res.status(400).json({ success: false, error: "هیچ فیلدی برای بروزرسانی ارسال نشده است" });
        }

        const values = [];
        const setSql = fields.map((key, idx) => {
            values.push(updates[key]);
            return `${key} = $${idx + 1}`;
        });

        values.push(memberId);

        const r = await pool.query(
            `UPDATE public.members
             SET ${setSql.join(", ")}, updated_at = NOW()
             WHERE id::text = $${values.length}
             RETURNING ${MEMBER_SELECT_COLUMNS}`,
            values
        );

        if (!r.rows.length) {
            return res.status(404).json({ success: false, error: "عضو یافت نشد" });
        }

        return res.json({ success: true, data: r.rows[0] });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
};

router.put("/update/:id", auth, updateMemberHandler);
router.put("/:id", auth, updateMemberHandler);

// ==========================================
// 7) حذف عضو
//    DELETE /api/members/:id
//    DELETE /api/members/delete/:id
// ==========================================
const deleteMemberHandler = async (req, res) => {
    try {
        const memberId = String(req.params.id || "").trim();
        const r = await pool.query(
            `DELETE FROM public.members
             WHERE id::text = $1
             RETURNING id`,
            [memberId]
        );

        if (!r.rows.length) {
            return res.status(404).json({ success: false, error: "عضو یافت نشد" });
        }

        return res.json({ success: true, data: { id: r.rows[0].id } });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
};

router.delete("/delete/:id", auth, deleteMemberHandler);
router.delete("/:id", auth, deleteMemberHandler);

module.exports = router;
