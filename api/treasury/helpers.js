const { pool, supabaseAdmin } = require("../../supabaseAdmin");

const getNumericMemberId = async (authUserId) => {
    if (!authUserId) return null;
    if (!isNaN(authUserId) && !String(authUserId).includes("-")) return Number(authUserId);
    const { data } = await supabaseAdmin.from('members').select('id').eq('auth_user_id', authUserId).maybeSingle();
    return data ? data.id : null;
};

const generateDocNo = async (memberId) => {
    const { count } = await supabaseAdmin.from("financial_documents").select("*", { count: "exact", head: true }).eq("member_id", memberId);
    return (Number(memberId) * 10000) + (count + 1);
};

// دریافت آیدی معین بر اساس کد حساب
const findMoeinIdByCode = async (code) => {
    const { data } = await supabaseAdmin
        .from("accounting_moein") // نام جدول معین
        .select("id")
        .eq("code", code)
        .limit(1)
        .maybeSingle();

    return data ? data.id : null;
};

module.exports = {
    getNumericMemberId,
    generateDocNo,
    findMoeinIdByCode
};