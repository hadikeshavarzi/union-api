const express = require("express");
const router = express.Router();
const authMiddleware = require("./middleware/auth");
const { sendReceiptToNwms, sendExitToNwms, revokeReceiptNwms, revokeExitNwms, getNwmsWarehouses } = require("./utils/nwms");

router.use(authMiddleware);

// رسید ما → رسید سامانه جامع
router.post("/send-receipt/:id", async (req, res) => {
    try {
        const memberId = req.user.member_id || req.user.id;
        const result = await sendReceiptToNwms(memberId, req.params.id);
        res.json({ success: true, nwms_id: result.nwmsId, data: result.data });
    } catch (err) {
        console.error("NWMS send receipt error:", err.message);
        res.status(400).json({ success: false, error: err.message });
    }
});

// خروجی ما → حواله سامانه جامع
router.post("/send-exit/:id", async (req, res) => {
    try {
        const memberId = req.user.member_id || req.user.id;
        const result = await sendExitToNwms(memberId, req.params.id);
        res.json({ success: true, nwms_id: result.nwmsId, data: result.data });
    } catch (err) {
        console.error("NWMS send exit error:", err.message);
        res.status(400).json({ success: false, error: err.message });
    }
});

// ابطال رسید در سامانه جامع
router.post("/revoke-receipt/:id", async (req, res) => {
    try {
        const memberId = req.user.member_id || req.user.id;
        const result = await revokeReceiptNwms(memberId, req.params.id);
        res.json({ success: true, data: result });
    } catch (err) {
        console.error("NWMS revoke receipt error:", err.message);
        res.status(400).json({ success: false, error: err.message });
    }
});

// ابطال خروجی (حواله) در سامانه جامع
router.post("/revoke-exit/:id", async (req, res) => {
    try {
        const memberId = req.user.member_id || req.user.id;
        const result = await revokeExitNwms(memberId, req.params.id);
        res.json({ success: true, data: result });
    } catch (err) {
        console.error("NWMS revoke exit error:", err.message);
        res.status(400).json({ success: false, error: err.message });
    }
});

// دریافت لیست واحدها
router.get("/warehouses", async (req, res) => {
    try {
        const memberId = req.user.member_id || req.user.id;
        const data = await getNwmsWarehouses(memberId);
        res.json({ success: true, data });
    } catch (err) {
        console.error("NWMS warehouses error:", err.message);
        res.status(400).json({ success: false, error: err.message });
    }
});

module.exports = router;
