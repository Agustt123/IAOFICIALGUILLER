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

    if (phone.includes("+54")) {
        phone = phone.replace(/^\+54/, "");
        phone = Number(phone);
    }

    const usuarios = {
        1144241507: "hola Box",
        1140880763: "hola Facu",
        2213056800: "Hola Chris",
        1123787254: "Hola Agus",
        1140415803: "Hola Den",
    }
    deviceStore.tokens.add(token);

    console.log('✅ Token guardado en memoria:', token);
    console.log('📦 Total tokens:', deviceStore.tokens.size);

    return res.json({ ok: true, saludo: usuarios[phone] });
};


export async function obtenerDispositivosActivos() {
    return [...deviceStore.tokens].map(token => ({ token }));
}

export function eliminarDispositivoPorToken(token) {
    const existed = deviceStore.tokens.delete(String(token));
    if (existed) {
        console.log("Token eliminado de memoria:", token);
        console.log("Total tokens:", deviceStore.tokens.size);
    }
    return existed;
}

export const clearDevices = async (_req, res) => {
    const total = deviceStore.tokens.size;
    deviceStore.tokens.clear();

    return res.json({
        ok: true,
        cleared: total,
        total: deviceStore.tokens.size,
    });
};



