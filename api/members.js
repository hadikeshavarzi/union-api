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

const IMAGE_FIELDS = new Set([
    "member_image",
    "national_card_image",
    "id_card_image",
    "license_image",
    "company_license_image",
]);

const REQUIRED_NOT_NULL_FIELDS = {
    role: "نقش کاربر الزامی است",
    full_name: "نام و نام خانوادگی الزامی است",
    mobile: "شماره موبایل الزامی است",
    member_code: "کد عضویت الزامی است",
};

const UPDATE_WHITELIST = [
    "role", "full_name", "father_name", "national_id", "mobile", "phone", "email", "address",
    "birth_date", "business_name", "category", "member_status", "license_number", "license_issue_date",
    "license_expire_date", "company_name", "registration_number", "member_code", "permissions", "owner_id",
    "member_image", "national_card_image", "id_card_image", "license_image", "company_license_image",
];

const SKIP_FIELD = Symbol("SKIP_FIELD");

const nullable = (value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === "string" && value.trim() === "") return null;
    return value;
};

const normalizePersianDigits = (value) =>
    String(value || "")
        .replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d))
        .replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d));

const normalizeIranMobile = (value) => {
    if (value === undefined || value === null) return null;
    const raw = normalizePersianDigits(value).trim();
    if (!raw) return null;

    let digits = raw.replace(/\D/g, "");

    if (digits.startsWith("0098")) digits = `0${digits.slice(4)}`;
    if (digits.startsWith("98") && digits.length === 12) digits = `0${digits.slice(2)}`;
    if (digits.startsWith("9") && digits.length === 10) digits = `0${digits}`;

    if (/^09\d{9}$/.test(digits)) return digits;

    // اگر فرمت غیرایرانی بود، همان مقدار trim شده را نگه می‌داریم تا دیتابیس text آن را بپذیرد
    return raw;
};

const normalizeUuid = (value) => {
    const v = nullable(value);
    if (!v) return null;
    const s = String(v).trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)
        ? s
        : null;
};

const parseBigIntField = (value) => {
    if (value === undefined) return SKIP_FIELD;
    if (value === null) return null;

    if (typeof value === "number" && Number.isFinite(value)) {
        return Math.trunc(value);
    }

    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) return null;
        if (/^\d+$/.test(trimmed)) return Number(trimmed);
        return SKIP_FIELD;
    }

    return SKIP_FIELD;
};

const normalizePermissions = (value) => {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") return value;

    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) return [];
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed) || (parsed && typeof parsed === "object")) {
                return parsed;
            }
        } catch (_) {
            // ignore parse error and fallback to []
        }
    }

    return [];
};

const normalizeFieldForUpdate = (key, value) => {
    if (key === "permissions") return normalizePermissions(value);
    if (key === "mobile") return normalizeIranMobile(value);

    if (key === "owner_id") {
        const owner = normalizeUuid(value);
        return owner ?? null;
    }

    if (IMAGE_FIELDS.has(key)) {
        // اگر URL یا مقدار غیرعددی بیاید، فیلد را در UPDATE نادیده می‌گیریم تا 500 رخ ندهد
        return parseBigIntField(value);
    }

    return nullable(value);
};

const pickEditableFields = (body = {}) => {
    const out = {};

    for (const key of UPDATE_WHITELIST) {
        if (!Object.prototype.hasOwnProperty.call(body, key)) continue;

        const normalized = normalizeFieldForUpdate(key, body[key]);
        if (normalized === SKIP_FIELD) continue;

        out[key] = normalized;
    }

    return out;
};

const mapRowToPayload = (body = {}, ownerId = null) => {
    const mobile = normalizeIranMobile(body.mobile);
    const memberCode = nullable(body.member_code) || mobile;

    const memberImage = parseBigIntField(body.member_image);
    const nationalCardImage = parseBigIntField(body.national_card_image);
    const idCardImage = parseBigIntField(body.id_card_image);
    const licenseImage = parseBigIntField(body.license_image);
    const companyLicenseImage = parseBigIntField(body.company_license_image);

    return {
        role: nullable(body.role) || "union_member",
        full_name: nullable(body.full_name),
        father_name: nullable(body.father_name),
        national_id: nullable(body.national_id),
        mobile,
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
        member_code: memberCode,
        permissions: normalizePermissions(body.permissions),
        owner_id: normalizeUuid(body.owner_id) || normalizeUuid(ownerId),
        member_image: memberImage === SKIP_FIELD ? null : memberImage,
        national_card_image: nationalCardImage === SKIP_FIELD ? null : nationalCardImage,
        id_card_image: idCardImage === SKIP_FIELD ? null : idCardImage,
        license_image: licenseImage === SKIP_FIELD ? null : licenseImage,
        company_license_image: companyLicenseImage === SKIP_FIELD ? null : companyLicenseImage,
    };
};

const ensureCreatePayload = (payload) => {
    if (!payload.mobile) return "شماره موبایل الزامی است";
    if (!payload.full_name) return "نام و نام خانوادگی الزامی است";
    if (!payload.member_code) return "کد عضویت الزامی است";
    if (!payload.role) return "نقش کاربر الزامی است";
    return null;
};

const ensureUpdatePayload = (updates) => {
    const keys = Object.keys(REQUIRED_NOT_NULL_FIELDS);
    for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(updates, key)) continue;
        if (updates[key] === null || updates[key] === undefined) {
            return REQUIRED_NOT_NULL_FIELDS[key];
        }
    }
    return null;
};

const sendDbError = (res, err, contextLabel = "members") => {
    if (err?.code === "23502") {
        const msg = err?.column
            ? `فیلد اجباری \"${err.column}\" ارسال نشده است`
            : "یکی از فیلدهای اجباری ارسال نشده است";
        return res.status(400).json({ success: false, error: msg });
    }

    if (err?.code === "22P02") {
        return res.status(400).json({ success: false, error: "فرمت یکی از فیلدها نامعتبر است" });
    }

    if (err?.code === "23505") {
        return res.status(409).json({ success: false, error: "رکورد تکراری است" });
    }

    console.error(`❌ [${contextLabel}]`, err);
    return res.status(500).json({ success: false, error: err?.message || "خطای داخلی سرور" });
};

const resolveOwnerIdFromRequest = (req) => {
    return normalizeUuid(req?.user?.member_id) || normalizeUuid(req?.user?.id);
};

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
                COALESCE(full_name, ) ILIKE $${values.length}
                OR COALESCE(company_name, ) ILIKE $${values.length}
                OR COALESCE(mobile, ) ILIKE $${values.length}
                OR COALESCE(member_code, ) ILIKE $${values.length}
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
        return sendDbError(res, e, "members/list");
    }
});

// ==========================================
// 2) دریافت کاربران سیستم (زیرمجموعه‌های یک مالک)
//    GET /api/members/system-users
// ==========================================
router.get("/system-users", auth, async (req, res) => {
    try {
        const ownerId = resolveOwnerIdFromRequest(req);
        if (!ownerId) {
            return res.status(400).json({ success: false, error: "شناسه مالک معتبر نیست" });
        }

        const r = await pool.query(
            `SELECT ${MEMBER_SELECT_COLUMNS}
             FROM public.members
             WHERE owner_id = $1
             ORDER BY created_at DESC`,
            [ownerId]
        );

        return res.json({ success: true, data: r.rows });
    } catch (e) {
        return sendDbError(res, e, "members/system-users:get");
    }
});

// ==========================================
// 3) ایجاد کاربر زیرمجموعه
//    POST /api/members/system-users
// ==========================================
router.post("/system-users", auth, async (req, res) => {
    try {
        const ownerId = resolveOwnerIdFromRequest(req);
        if (!ownerId) {
            return res.status(400).json({ success: false, error: "شناسه مالک معتبر نیست" });
        }

        const body = req.body || {};
        const payload = mapRowToPayload(body, ownerId);

        const payloadError = ensureCreatePayload(payload);
        if (payloadError) {
            return res.status(400).json({ success: false, error: payloadError });
        }

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
        return sendDbError(res, e, "members/system-users:post");
    }
});

// ==========================================
// 4) ایجاد عضو عمومی
//    POST /api/members
// ==========================================
router.post("/", auth, async (req, res) => {
    try {
        const body = req.body || {};
        const payload = mapRowToPayload(body, null);

        const payloadError = ensureCreatePayload(payload);
        if (payloadError) {
            return res.status(400).json({ success: false, error: payloadError });
        }

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
        return sendDbError(res, e, "members:post");
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
        return sendDbError(res, e, "members/:id:get");
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

        const updateError = ensureUpdatePayload(updates);
        if (updateError) {
            return res.status(400).json({ success: false, error: updateError });
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
        return sendDbError(res, e, "members:update");
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
        return sendDbError(res, e, "members:delete");
    }
};

router.delete("/delete/:id", auth, deleteMemberHandler);
router.delete("/:id", auth, deleteMemberHandler);

module.exports = router;
