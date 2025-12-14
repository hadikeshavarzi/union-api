import axios from "axios";

const username = process.env.MELIPAYAMAK_USERNAME;
const password = process.env.MELIPAYAMAK_PASSWORD;
const sender = process.env.SMS_SENDER_NUMBER;

export async function sendOtpSms(to, message) {
    try {
        const url = "https://rest.payamak-panel.com/api/SendSMS/SendSMS";
        const payload = {
            username,
            password,
            to,
            from: sender,
            text: message,
            isFlash: false,
        };

        const res = await axios.post(url, payload);
        return res.data;
    } catch (err) {
        console.error("SMS Error:", err?.response?.data || err);
        throw new Error("خطا در ارسال پیامک");
    }
}
