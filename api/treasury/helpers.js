const { pool } = require("../../supabaseAdmin");

const isUUID = (str) => str && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

const getNumericMemberId = async (authUserId) => {
    if (!authUserId) return null;
    if (!isNaN(authUserId) && !String(authUserId).includes("-")) return Number(authUserId);
    const { rows } = await pool.query('SELECT id FROM members WHERE auth_user_id = $1 LIMIT 1', [authUserId]);
    return rows.length > 0 ? rows[0].id : null;
};

const generateDocNo = async (memberId) => {
    const { rows } = await pool.query(
        "SELECT COUNT(*)::int as cnt FROM financial_documents WHERE member_id = $1",
        [memberId]
    );
    const count = rows[0]?.cnt || 0;
    return (Number(memberId) * 10000) + (count + 1);
};

const findMoeinIdByCode = async (code, memberId) => {
    const { rows } = await pool.query(
        "SELECT id FROM accounting_moein WHERE code = $1 AND member_id = $2 LIMIT 1",
        [code, memberId]
    );
    return rows.length > 0 ? rows[0].id : null;
};

module.exports = {
    getNumericMemberId,
    generateDocNo,
    findMoeinIdByCode,
    isUUID
};
