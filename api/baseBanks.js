// api/baseBanks.js
const express = require("express");
const authMiddleware = require("./middleware/auth");

const router = express.Router();

/* GET ALL BASE BANKS */
router.get("/", authMiddleware, async (req, res) => {
    try {
        // لیست استاتیک بانک‌های ایران
        const banks = [
            { id: 1, name: "ملت", code: "012" },
            { id: 2, name: "ملی", code: "017" },
            { id: 3, name: "تجارت", code: "018" },
            { id: 4, name: "صادرات", code: "020" },
            { id: 5, name: "سپه", code: "015" },
            { id: 6, name: "پارسیان", code: "054" },
            { id: 7, name: "پاسارگاد", code: "057" },
            { id: 8, name: "اقتصاد نوین", code: "055" },
            { id: 9, name: "سامان", code: "056" },
            { id: 10, name: "رفاه", code: "013" },
            { id: 11, name: "کشاورزی", code: "016" },
            { id: 12, name: "صنعت و معدن", code: "011" },
            { id: 13, name: "دی", code: "051" },
            { id: 14, name: "شهر", code: "061" },
            { id: 15, name: "مسکن", code: "014" },
            { id: 16, name: "انصار", code: "063" },
            { id: 17, name: "مهر اقتصاد", code: "075" },
            { id: 18, name: "ایران زمین", code: "069" },
            { id: 19, name: "کارآفرین", code: "053" }
        ];

        return res.json({ success: true, data: banks });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;