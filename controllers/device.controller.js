import { db } from "../config/db.js";

export const registerDevice = async (req, res) => {
    const { idUsuario, token, plataforma } = req.body;

    if (!idUsuario || !token) {
        return res.status(400).json({ error: "idUsuario y token son requeridos" });
    }

    try {
        const [rows] = await db.query(
            "INSERT INTO devices (idUsuario, token, plataforma) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE plataforma = VALUES(plataforma)",
            [idUsuario, token, plataforma || "android"]
        );

        res.json({ success: true, message: "Device registrado", result: rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err });
    }
};
