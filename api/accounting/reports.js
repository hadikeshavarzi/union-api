const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth'); // توجه کنید که مسیر میدل‌ور یک پله عقب‌تر است

// مسیر: GET /api/accounting/reports/my-turnover
router.get('/my-turnover', auth, async (req, res) => {
    try {
        // const userId = req.user.id;
        
        // بازگشت لیست خالی برای رفع ارور
        res.json({
            success: true,
            data: [] 
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 'Server Error' });
    }
});

module.exports = router;
