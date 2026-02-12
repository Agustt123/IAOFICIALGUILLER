import axios from "axios";
import admin from "firebase-admin";
import { createCanvas, registerFont } from "canvas";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

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
    console.error(
        "⚠️ No se pudo registrar la fuente. Se verá mal el texto:",
        e?.message || e
    );
}

// =====================
// Monitoreo: regla de fallo
// =====================
const FAIL_MS = 2000; // fallo si null/undefined o > 2000ms

function isFail(ms) {
    if (ms === null || ms === undefined) return true;
    const n = Number(ms);
    return !Number.isFinite(n) || n > FAIL_MS;
}

function computeConsecutiveFails(registros) {
    if (!Array.isArray(registros) || registros.length === 0) {
        return { maxStreak: 0, afectados: [] };
    }

    // claves de microservicios (todo menos id/autofecha)
    const sample = registros[0] || {};
    const keys = Object.keys(sample).filter(
        (k) => k !== "id" && k !== "autofecha"
    );

    const afectados = [];

    for (const micro of keys) {
        let streak = 0;
        for (const row of registros) {
            if (isFail(row?.[micro])) streak++;
            else break; // buscamos consecutivos desde el más nuevo
        }
        if (streak > 0) afectados.push({ micro, streak });
    }

    afectados.sort(
        (a, b) => b.streak - a.streak || a.micro.localeCompare(b.micro)
    );
    const maxStreak = afectados[0]?.streak ?? 0;

    return { maxStreak, afectados };
}

function barStyle(maxStreak) {
    // 0 => verde OK
    // 1 => verde con nombres
    // 2 => amarillo
    // 3 => naranja
    // 4+ => rojo
    if (maxStreak >= 4) return { bg: "#dc2626", fg: "#ffffff", title: "CRÍTICO" };
    if (maxStreak === 3) return { bg: "#f97316", fg: "#111827", title: "ALTO" };
    if (maxStreak === 2)
        return { bg: "#facc15", fg: "#111827", title: "ATENCIÓN" };
    if (maxStreak === 1)
        return { bg: "#22c55e", fg: "#052e16", title: "OK (con alertas)" };
    return { bg: "#22c55e", fg: "#052e16", title: "TODO OK" };
}

// =====================
// Hash estable para "no enviar si no cambió"
// (SIN FIRESTORE: guardamos en memoria)
// =====================
function stableStringify(obj) {
    const allKeys = [];
    JSON.stringify(obj, (k, v) => (allKeys.push(k), v));
    allKeys.sort();
    return JSON.stringify(obj, allKeys);
}

function sha256(str) {
    return crypto.createHash("sha256").update(str).digest("hex");
}

// ✅ Estado en memoria (no rompe si Firestore está deshabilitado)
// OJO: se pierde al reiniciar el proceso
const lastHashByToken = new Map();

async function getLastHash(token) {
    return lastHashByToken.get(String(token)) ?? null;
}

async function setLastHash(token, lastHash) {
    lastHashByToken.set(String(token), String(lastHash));
}
export function todayLocalYYYYMMDD() {
    const d = new Date();

    // restar 3 horas
    d.setHours(d.getHours() - 3);
    console.log(d);

    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");

    return `${y}-${m}-${day}`;
}


// =====================
// Data fetch
// =====================
export async function obtenerCantidad(dia) {
    // Si no viene dia, usar hoy en YYYY-MM-DD (UTC para evitar desfases por zona horaria)
    const diaFinal =
        typeof dia === "string" && dia.trim()
            ? dia
            : todayLocalYYYYMMDD();

    console.log(`Obteniendo cantidad de paquetes para ${diaFinal}`);
    const { data } = await axios.post(
        "http://dw.lightdata.app/cantidad",
        { dia: diaFinal },
        { timeout: 100000 }
    );

    // ✅ FIX: axios devuelve { data }, y en GET los params van en "params"
    const { data: dataServidores } = await axios.get(
        "http://dw.lightdata.app/monitoreo",
        {
            timeout: 100000,
            params: { dia: diaFinal }, // si tu backend no lo usa, no molesta
        }
    );

    if (!data?.ok) {
        throw new Error(`Respuesta inválida de /cantidad: ${JSON.stringify(data)}`);
    }

    // Validación monitoreo
    if (!dataServidores?.estado || !Array.isArray(dataServidores?.data)) {
        throw new Error(
            `Respuesta inválida de /monitoreo: ${JSON.stringify(dataServidores)}`
        );
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
        mesNombre: data.nombre,
        monitoreo: dataServidores, // <-- agregamos monitoreo
    };
}

function monthNameEsFromFecha(fechaYYYYMMDD) {
    const d = new Date(`${fechaYYYYMMDD}T00:00:00Z`);
    const fmt = new Intl.DateTimeFormat("es-AR", { month: "long" });
    const name = fmt.format(d);
    return name.charAt(0).toUpperCase() + name.slice(1);
}

function drawStatusBarTop(ctx, width, monitoreo) {
    const registros = monitoreo?.data ?? [];
    const { maxStreak, afectados } = computeConsecutiveFails(registros);
    const style = barStyle(maxStreak);

    const barH = 62;
    const y = 0;

    // Fondo franja
    ctx.fillStyle = style.bg;
    ctx.fillRect(0, y, width, barH);

    // Icon + título
    ctx.fillStyle = style.fg;
    ctx.font = 'bold 22px "DejaVuSans"';
    const title = maxStreak === 0 ? "" : `⚠️ ${style.title}`;
    ctx.fillText(title, 22, y + 40);

    // Lista micros (si hay)
    if (maxStreak > 0 && afectados.length > 0) {
        const list = afectados
            .slice(0, 10)
            .map((x) => `${x.micro}(${x.streak})`)
            .join(", ");

        ctx.font = '18px "DejaVuSans"';
        // texto a la derecha del título
        ctx.fillText(list, 200, y + 40);
    }

    return { maxStreak, afectados, barH };
}

function generarImagenResumenBuffer({ fecha, mes, cantidadDia, cantidadMes, monitoreo }) {
    const width = 900;
    const height = 460;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    // Formato miles
    const nf = new Intl.NumberFormat("es-AR");
    const cantidadDiaFmt = nf.format(Number(cantidadDia));
    const cantidadMesFmt = nf.format(Number(cantidadMes));

    // ===== Fondo
    ctx.fillStyle = "#0b1220";
    ctx.fillRect(0, 0, width, height);

    // ===== Franja arriba
    const status = drawStatusBarTop(ctx, width, monitoreo);
    const topBarH = status.barH || 62;

    // ===== Card principal
    const cardX = 40;
    const cardY = topBarH + 20;
    const cardW = width - 80;
    const cardH = height - cardY - 40;

    ctx.fillStyle = "#111b2e";
    ctx.fillRect(cardX, cardY, cardW, cardH);

    // ===== Mes y año (SIN día)
    const year = String(fecha).slice(0, 4);
    const monthName = monthNameEsFromFecha(fecha); // "Febrero"

    // Mes centrado arriba
    ctx.fillStyle = "#cbd5e1";
    ctx.font = 'bold 44px "DejaVuSans"';
    const monthW = ctx.measureText(monthName).width;
    ctx.fillText(monthName, cardX + cardW / 2 - monthW / 2, cardY + 95);

    // Línea sutil
    ctx.fillStyle = "#1f2a44";
    ctx.fillRect(cardX + 40, cardY + 120, cardW - 80, 2);

    // ===== Totales (dos columnas)
    const leftX = cardX + 60;
    const rightX = cardX + 480;
    const baseY = cardY + 250;

    // Total del día
    ctx.fillStyle = "#ffffff";
    ctx.font = 'bold 66px "DejaVuSans"';
    ctx.fillText(cantidadDiaFmt, leftX, baseY);

    ctx.fillStyle = "#cbd5e1";
    ctx.font = '22px "DejaVuSans"';
    ctx.fillText("Total del día", leftX, baseY + 35);

    // Total del mes
    ctx.fillStyle = "#ffffff";
    ctx.font = 'bold 52px "DejaVuSans"';
    ctx.fillText(cantidadMesFmt, rightX, baseY);

    ctx.fillStyle = "#cbd5e1";
    ctx.font = '22px "DejaVuSans"';
    ctx.fillText("Total del mes", rightX, baseY + 35);

    // ===== Año abajo al medio
    ctx.fillStyle = "#94a3b8";
    ctx.font = 'bold 32px "DejaVuSans"';
    const yearW = ctx.measureText(year).width;
    ctx.fillText(year, cardX + cardW / 2 - yearW / 2, cardY + cardH - 35);

    const buf = canvas.toBuffer("image/png");
    console.log("PNG bytes:", buf.length);
    return { buf, status };
}


// =====================
// Subida SAT
// =====================
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

// =====================
// POST /imagenes/cantidad/push
// =====================
export const enviarResumenCantidadPush = async (req, res) => {
    const { token, dia, titulo, cuerpo, nombre } = req.body;

    if (!dia) {
        return res.status(400).json({ ok: false, msg: "Faltan parámetros: dia" });
    }
    if (!token) {
        return res.status(400).json({ ok: false, msg: "Faltan parámetros: token" });
    }

    try {
        const { fecha, mes, cantidadDia, cantidadMes, monitoreo } =
            await obtenerCantidad(dia);

        // =====================
        // NO enviar si no cambió (incluye monitoreo)
        // =====================
        const registros = monitoreo?.data ?? [];
        const { maxStreak, afectados } = computeConsecutiveFails(registros);

        const logicalPayload = {
            fecha: String(fecha),
            mes: String(mes),
            cantidadDia: Number(cantidadDia),
            cantidadMes: Number(cantidadMes),
            maxStreak,
            afectados: afectados.map((x) => ({ micro: x.micro, streak: x.streak })),
        };

        const currentHash = sha256(stableStringify(logicalPayload));
        const lastHash = await getLastHash(token);

        if (lastHash && lastHash === currentHash) {
            return res.json({
                ok: true,
                skipped: true,
                msg: "Sin cambios: no se envía notificación (se mantiene la anterior).",
                logicalPayload,
            });
        }

        // Generamos imagen (1 sola imagen con franja)
        const { buf: bufferPng, status } = generarImagenResumenBuffer({
            fecha,
            mes,
            cantidadDia,
            cantidadMes,
            monitoreo,
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

                // info útil extra (por si querés en el cliente)
                maxStreak: String(status?.maxStreak ?? 0),
                afectados: JSON.stringify(status?.afectados ?? []),

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

        // guardamos hash post-envío (memoria)
        await setLastHash(token, currentHash);

        return res.json({
            ok: true,
            fecha,
            mes,
            cantidadDia,
            cantidadMes,
            imageUrl,
            status,
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

// =====================
// Uso interno: generar y enviar
// =====================
export async function generarYEnviarResumen({ token, dia }) {
    console.log(`Generando y enviando resumen para token ${token} y día ${dia}`);

    const { fecha, mes, cantidadDia, cantidadMes, monitoreo } =
        await obtenerCantidad(dia);

    // NO enviar si no cambió
    const registros = monitoreo?.data ?? [];
    const { maxStreak, afectados } = computeConsecutiveFails(registros);

    const logicalPayload = {
        fecha: String(fecha),
        mes: String(mes),
        cantidadDia: Number(cantidadDia),
        cantidadMes: Number(cantidadMes),
        maxStreak,
        afectados: afectados.map((x) => ({ micro: x.micro, streak: x.streak })),
    };

    const currentHash = sha256(stableStringify(logicalPayload));
    const lastHash = await getLastHash(token);

    if (lastHash && lastHash === currentHash) {
        console.log("Sin cambios: no se envía notificación (se mantiene la anterior).");
        return { skipped: true };
    }

    const { buf: bufferPng, status } = generarImagenResumenBuffer({
        fecha,
        mes,
        cantidadDia,
        cantidadMes,
        monitoreo,
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
            channelId: "silent_high",
            imageUrl,
            fecha: String(fecha),
            mes: String(mes),
            cantidadDia: String(cantidadDia),
            cantidadMes: String(cantidadMes),
            maxStreak: String(status?.maxStreak ?? 0),
            afectados: JSON.stringify(status?.afectados ?? []),
        },
        android: {
            notification: { imageUrl },

            priority: "HIGH",
        },
    }


    console.log("FCM message:", message);

    const resp = await admin.messaging().send(message);
    await setLastHash(token, currentHash);

    return resp;
}
