// api/middleware/auth.js (اصلاح شده)
const jwt = require('jsonwebtoken');

function authMiddleware(req, res, next) {
    const auth = req.headers.authorization || '';

    if (!auth.startsWith('Bearer ')) {
        console.log(`❌ No token: ${req.method} ${req.path}`);
        return res.status(401).json({
            success: false,
            error: 'توکن ارسال نشده'
        });
    }

    try {
        const token = auth.slice(7);
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        console.log(`✅ Auth OK: User ${decoded.id} → ${req.method} ${req.path}`);

        req.user = decoded;
        next();
    } catch (err) {
        console.error(`❌ Auth Failed: ${req.method} ${req.path} - ${err.message}`);
        return res.status(401).json({
            success: false,
            error: 'توکن نامعتبر است'
        });
    }
}

module.exports = { authMiddleware };