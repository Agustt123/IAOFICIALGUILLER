import admin from "firebase-admin";
import { db } from "../config/db.js";

// ------------ Enviar notificación a un TOKEN especifico ------------
export const sendFCM = async (req, res) => {
    const { token, title, body, data } = req.body;

    if (!token) return res.status(400).json({ error: "token requerido" });

    const message = {
        token,
        notification: { title, body },
        data: data || {}
    };

    try {
        const response = await admin.messaging().send(message);
        return res.json({ success: true, response });
    } catch (error) {
        console.error("Error al enviar FCM:", error);
        return res.status(500).json({ success: false, error });
    }
};
