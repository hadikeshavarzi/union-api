// api/utils/member.js
const { supabaseAdmin } = require("../../supabaseAdmin");

/**
 * تبدیل req.user.id (UUID) به members.id (bigint)
 */
async function getNumericMemberId(idInput) {
    if (!idInput) return null;

    // اگر خودش عدد بود
    if (!isNaN(idInput) && !String(idInput).includes("-")) {
        return Number(idInput);
    }

    const { data, error } = await supabaseAdmin
        .from("members")
        .select("id")
        .eq("auth_user_id", idInput)
        .maybeSingle();

    if (error) throw new Error(error.message);
    return data?.id ? Number(data.id) : null;
}

module.exports = { getNumericMemberId };
