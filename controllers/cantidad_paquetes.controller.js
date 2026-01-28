import axios from "axios";
import admin from "firebase-admin";
import { createCanvas, registerFont } from "canvas";
import path from "path";
import { fileURLToPath } from "url";

// =====================
// Fuente (evita "cuadritos")
// =====================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ajustá esta ruta a donde pongas el TTF
// Recomendado: /assets/fonts/DejaVuSans.ttf
const FONT_PATH = path.join(__dirname, "../assets/fonts/DejaVuSans.ttf");

// Registrar fuente una sola vez
try {
    registerFont(FONT_PATH, { family: "DejaVuSans" });
    console.log("✅ Fuente registrada:", FONT_PATH);
} catch (e) {
    console.error("⚠️ No se pudo registrar la fuente. Se verá mal el texto:", e?.message || e);
}

async function obtenerCantidad(dia) {
    const { data } = await axios.post(
        "http://dw.lightdata.app/cantidad",
        { dia },
        { timeout: 50000 }
    );

    if (!data?.ok) {
        throw new Error(`Respuesta inválida de /cantidad: ${JSON.stringify(data)}`);
    }

    return {
        fecha: data.fecha ?? dia,
        cantidad: Number(data.cantidad ?? 0),
    };
}

function generarImagenResumenBuffer({ fecha, cantidad }) {
    const width = 900;
    const height = 420;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "#0b1220";
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = "#111b2e";
    ctx.fillRect(40, 40, width - 80, height - 80);

    ctx.fillStyle = "#ffffff";
    ctx.font = 'bold 36px "DejaVuSans"';
    ctx.fillText("Resumen Global", 80, 115);

    ctx.fillStyle = "#cbd5e1";
    ctx.font = '24px "DejaVuSans"';
    ctx.fillText(`Fecha: ${fecha}`, 80, 165);

    ctx.fillStyle = "#ffffff";
    ctx.font = 'bold 72px "DejaVuSans"';
    ctx.fillText(`${cantidad}`, 80, 270);

    ctx.fillStyle = "#cbd5e1";
    ctx.font = '24px "DejaVuSans"';
    ctx.fillText("Paquetes únicos", 80, 305);

    const buf = canvas.toBuffer("image/png");
    console.log("PNG bytes:", buf.length);
    return buf;
}

async function subirImagenSAT({ bufferPng, nombre }) {
    const base64 = bufferPng.toString("base64");

    const payload = {
        foto: `image/png;base64,${base64}`,
        nombre: String(nombre),
    };

    const resp = await axios.post(
        "https://files.lightdata.app/sat/guardarFotosSAT.php",
        payload,
        {
            timeout: 200000,
            headers: { "Content-Type": "application/json" },
            responseType: "text",
            transformResponse: (r) => r,
        }
    );

    const url = String(resp.data || "").trim();
    if (!url.startsWith("http")) {
        throw new Error(`SAT no devolvió URL válida: ${url}`);
    }

    return url;
}

// POST /imagenes/cantidad/push
export const enviarResumenCantidadPush = async (req, res) => {
    const { token, dia, titulo, cuerpo, nombre } = req.body;

    if (!dia) {
        return res.status(400).json({ ok: false, msg: "Faltan parámetros: dia" });
    }

    try {
        const { fecha, cantidad } = await obtenerCantidad(dia);

        const bufferPng = generarImagenResumenBuffer({ fecha, cantidad });

        const safeFecha = String(fecha).replace(/[^0-9a-zA-Z_-]/g, "-");
        const nombreSAT =
            (nombre && String(nombre)) || `resumen_${safeFecha}_${Date.now()}.png`;

        const imageUrl = await subirImagenSAT({ bufferPng, nombre: nombreSAT });

        const message = {
            token,
            // notification opcional
            // notification: {
            //   title: titulo || "Resumen Global",
            //   body: cuerpo || `Paquetes: ${cantidad} (${fecha})`,
            //   imageUrl,
            // },
            data: {
                imageUrl,
                fecha: String(fecha),
                cantidad: String(cantidad),
            },
            android: {
                notification: { imageUrl },
                priority: "HIGH",
            },
        };

        console.log("FCM message:", message);

        const fcmResponse = await admin.messaging().send(message);

        return res.json({
            ok: true,
            fecha,
            cantidad,
            imageUrl,
            fcmResponse,
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({
            ok: false,
            msg: "Error generando/enviando resumen",
            error: String(error?.message || error),
        });
    }
};

export async function generarYEnviarResumen({ token, dia }) {
    console.log(`Generando y enviando resumen para token ${token} y día ${dia}`);

    const { fecha, cantidad } = await obtenerCantidad(dia);

    const bufferPng = generarImagenResumenBuffer({ fecha, cantidad });

    const safeFecha = String(fecha).replace(/[^0-9a-zA-Z_-]/g, "-");
    const nombreSAT = `resumen_${safeFecha}_${Date.now()}.png`;

    const imageUrl = await subirImagenSAT({
        bufferPng,
        nombre: nombreSAT,
    });

    const message = {
        token,
        data: {
            imageUrl,
            fecha: String(fecha),
            cantidad: String(cantidad),
        },
        android: {
            priority: "HIGH",
        },
    };

    console.log("FCM message:", message);

    return admin.messaging().send(message);
}
