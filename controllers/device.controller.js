import { db } from "../config/db.js";
import { deviceStore } from "../uttils/device.store.js";

export const registerDevice = async (req, res) => {
    const { phone, token, plataforma } = req.body;
    console.log('📥 /device/register BODY:', req.body);

    if (!phone || !token) {
        return res.status(400).json({
            ok: false,
            error: "phone y token son requeridos",
        });
    }

    deviceStore.tokens.add(token);

    console.log('✅ Token guardado en memoria:', token);
    console.log('📦 Total tokens:', deviceStore.tokens.size);

    return res.json({ ok: true });
};


export async function obtenerDispositivosActivos() {
    return [...deviceStore.tokens].map(token => ({ token }));
}



