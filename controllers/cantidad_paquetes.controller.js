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

const FONT_PATH = path.join(__dirname, "../assets/fonts/DejaVuSans.ttf");

try {
    registerFont(FONT_PATH, { family: "DejaVuSans" });
    console.log("✅ Fuente registrada:", FONT_PATH);
} catch (e) {
    console.error("⚠️ No se pudo registrar la fuente. Se verá mal el texto:", e?.message || e);
}

export async function obtenerCantidad(dia) {
    // Si no viene dia, usar hoy en YYYY-MM-DD (UTC para evitar desfases por zona horaria)
    const diaFinal =
        typeof dia === "string" && dia.trim()
            ? dia
            : new Date().toISOString().slice(0, 10);

    const { data } = await axios.post(
        "http://dw.lightdata.app/cantidad",
        { dia: diaFinal },
        { timeout: 100000 }
    );

    if (!data?.ok) {
        throw new Error(`Respuesta inválida de /cantidad: ${JSON.stringify(data)}`);
    }

    // Soporta ambos formatos:
    // - nuevo: { cantidadDia, cantidadMes, mes, fecha }
    // - viejo: { cantidad }
    const cantidadDia = Number(data.cantidadDia ?? data.cantidad ?? 0);
    const cantidadMes = Number(data.cantidadMes ?? 0);

    return {
        fecha: data.fecha ?? diaFinal,
        mes: data.mes ?? String(diaFinal).slice(0, 7),
        cantidadDia,
        cantidadMes,
        mesNombre: data.nombre
    };
}


function generarImagenResumenBuffer({ fecha, mes, cantidadDia, cantidadMes }) {
    const width = 900;
    const height = 460;
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
    ctx.fillText(`Mes: ${mes}`, 80, 200);

    // Día
    ctx.fillStyle = "#ffffff";
    ctx.font = 'bold 64px "DejaVuSans"';
    ctx.fillText(`${cantidadDia}`, 80, 290);

    ctx.fillStyle = "#cbd5e1";
    ctx.font = '22px "DejaVuSans"';
    ctx.fillText("Únicos del día", 80, 325);

    // Mes (a la derecha)
    ctx.fillStyle = "#ffffff";
    ctx.font = 'bold 48px "DejaVuSans"';
    ctx.fillText(`${cantidadMes}`, 520, 290);

    ctx.fillStyle = "#cbd5e1";
    ctx.font = '22px "DejaVuSans"';
    ctx.fillText("Únicos del mes", 520, 325);

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
    if (!token) {
        return res.status(400).json({ ok: false, msg: "Faltan parámetros: token" });
    }

    try {
        const { fecha, mes, cantidadDia, cantidadMes } = await obtenerCantidad(dia);

        const bufferPng = generarImagenResumenBuffer({
            fecha,
            mes,
            cantidadDia,
            cantidadMes,
        });

        const safeFecha = String(fecha).replace(/[^0-9a-zA-Z_-]/g, "-");
        const nombreSAT =
            (nombre && String(nombre)) || `resumen_${safeFecha}_${Date.now()}.png`;

        const imageUrl = await subirImagenSAT({ bufferPng, nombre: nombreSAT });

        const message = {
            token,
            data: {
                imageUrl,
                fecha: String(fecha),
                mes: String(mes),
                cantidadDia: String(cantidadDia),
                cantidadMes: String(cantidadMes),
                // opcional: si querés incluir los textos que te mandan
                ...(titulo ? { titulo: String(titulo) } : {}),
                ...(cuerpo ? { cuerpo: String(cuerpo) } : {}),
            },
            android: {
                notification: { imageUrl },
                channelId: "silent_high",
                priority: "HIGH",
            },
        };

        console.log("FCM message:", message);

        const fcmResponse = await admin.messaging().send(message);

        return res.json({
            ok: true,
            fecha,
            mes,
            cantidadDia,
            cantidadMes,
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

    const { fecha, mes, cantidadDia, cantidadMes } = await obtenerCantidad(dia);

    const bufferPng = generarImagenResumenBuffer({
        fecha,
        mes,
        cantidadDia,
        cantidadMes,
    });

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
            mes: String(mes),
            cantidadDia: String(cantidadDia),
            cantidadMes: String(cantidadMes),
        },
        android: {
            priority: "HIGH",
        },
    };

    console.log("FCM message:", message);

    return admin.messaging().send(message);
}
