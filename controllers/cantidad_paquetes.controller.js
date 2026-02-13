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
    console.error("⚠️ No se pudo registrar la fuente. Se verá mal el texto:", e?.message || e);
}

// =====================
// Monitoreo: regla de fallo (latencias por microservicio)
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
    const keys = Object.keys(sample).filter((k) => k !== "id" && k !== "autofecha");

    const afectados = [];

    for (const micro of keys) {
        let streak = 0;
        for (const row of registros) {
            if (isFail(row?.[micro])) streak++;
            else break; // consecutivos desde el más nuevo
        }
        if (streak > 0) afectados.push({ micro, streak });
    }

    afectados.sort((a, b) => b.streak - a.streak || a.micro.localeCompare(b.micro));
    const maxStreak = afectados[0]?.streak ?? 0;

    return { maxStreak, afectados };
}

function barStyle(maxStreak) {
    if (maxStreak >= 4) return { bg: "#dc2626", fg: "#ffffff", title: "CRÍTICO" };
    if (maxStreak === 3) return { bg: "#f97316", fg: "#111827", title: "ALTO" };
    if (maxStreak === 2) return { bg: "#facc15", fg: "#111827", title: "ATENCIÓN" };
    if (maxStreak === 1) return { bg: "#22c55e", fg: "#052e16", title: "OK (con alertas)" };
    return { bg: "#22c55e", fg: "#052e16", title: "TODO OK" };
}

// =====================
// Hash estable para "no enviar si no cambió" (en memoria)
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

// Estado en memoria por token (se pierde al reiniciar)
const lastHashByToken = new Map();

async function getLastHash(token) {
    return lastHashByToken.get(String(token)) ?? null;
}

async function setLastHash(token, lastHash) {
    lastHashByToken.set(String(token), String(lastHash));
}

// =====================
// Fecha local (AR) simple
// =====================
export function todayLocalYYYYMMDD() {
    const d = new Date();
    d.setHours(d.getHours() - 3); // AR
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

// =====================
// Fetch de cantidad + monitoreo micros (latencias)
// =====================
export async function obtenerCantidad(dia) {
    const diaFinal = typeof dia === "string" && dia.trim() ? dia : todayLocalYYYYMMDD();

    console.log(`Obteniendo cantidad de paquetes para ${diaFinal}`);

    const { data } = await axios.post(
        "http://dw.lightdata.app/cantidad",
        { dia: diaFinal },
        { timeout: 100000 }
    );

    const { data: dataServidores } = await axios.get("http://dw.lightdata.app/monitoreo", {
        timeout: 100000,
        params: { dia: diaFinal },
    });

    if (!data?.ok) {
        throw new Error(`Respuesta inválida de /cantidad: ${JSON.stringify(data)}`);
    }

    if (!dataServidores?.estado || !Array.isArray(dataServidores?.data)) {
        throw new Error(`Respuesta inválida de /monitoreo: ${JSON.stringify(dataServidores)}`);
    }

    const cantidadDia = Number(data.cantidadDia ?? data.cantidad ?? 0);
    const cantidadMes = Number(data.cantidadMes ?? 0);

    return {
        fecha: data.fecha ?? diaFinal,
        mes: data.mes ?? String(diaFinal).slice(0, 7),
        cantidadDia,
        cantidadMes,
        mesNombre: data.nombre,
        monitoreo: dataServidores,
    };
}

// =====================
// NUEVO: Fetch de métricas (conjunto) desde el endpoint nuevo
// Formato real:
// { estado:true, data:{ did, rows:[{ servidor:'conjunto', usoCpu:'12.6', usoRam:'24.1', usoDisco:'59.0', ... }] } }
// =====================
function toNum(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

export async function obtenerMetricasConjunto() {
    const { data } = await axios.get("https://dw.lightdata.app/monitoreo/metricas", {
        timeout: 15000,
    });

    if (!data?.estado || !data?.data?.rows?.length) {
        throw new Error(`Respuesta inválida de /monitoreo/metricas: ${JSON.stringify(data)}`);
    }

    const row = data.data.rows[0] || {};

    // temperaturaCpu la ignoramos (viene 0.0 en tu ejemplo)
    return {
        did: Number(data.data.did ?? row.did ?? 0) || null,
        usoCpu: toNum(row.usoCpu),
        usoRam: toNum(row.usoRam),
        usoDisco: toNum(row.usoDisco),
        // opcionales por si querés futuro:
        carga1m: toNum(row.carga1m),
        latenciaMs: toNum(row.latenciaMs),
    };
}

// =====================
// Semáforo de métricas (línea fina en franja negra)
// Reglas:
// - verde: 0 >=80
// - amarillo: 1 >=80
// - naranja: 2 >=80
// - rojo: 3 o más >=80
// =====================
const METRIC_WARN_PCT = 80;

function computeMetricsSeverity(metricas) {
    const vals = [metricas?.usoCpu, metricas?.usoRam, metricas?.usoDisco]
        .map((v) => toNum(v))
        .filter((v) => v !== null);

    const over = vals.filter((v) => v >= METRIC_WARN_PCT).length;

    if (over >= 3) return { color: "#dc2626", level: "CRÍTICO", overCount: over };
    if (over === 2) return { color: "#f97316", level: "ALTO", overCount: over };
    if (over === 1) return { color: "#facc15", level: "ATENCIÓN", overCount: over };
    return { color: "#22c55e", level: "OK", overCount: over };
}

function drawMetricsBar(ctx, width, topY, metricas) {
    const barH = 52;
    const y = topY;

    // fondo negro
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, y, width, barH);

    // línea fina central
    const sev = computeMetricsSeverity(metricas);
    const lineH = 6;
    const lineY = y + barH / 2 - lineH / 2;

    ctx.fillStyle = sev.color;
    ctx.fillRect(0, lineY, width, lineH);

    return { barH, sev };
}

// =====================
// Helpers de fecha / UI
// =====================
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

    ctx.fillStyle = style.bg;
    ctx.fillRect(0, y, width, barH);

    ctx.fillStyle = style.fg;
    ctx.font = 'bold 22px "DejaVuSans"';
    const title = maxStreak === 0 ? "" : `⚠️ ${style.title}`;
    ctx.fillText(title, 22, y + 40);

    if (maxStreak > 0 && afectados.length > 0) {
        const list = afectados
            .slice(0, 10)
            .map((x) => `${x.micro}(${x.streak})`)
            .join(", ");
        ctx.font = '18px "DejaVuSans"';
        ctx.fillText(list, 200, y + 40);
    }

    return { maxStreak, afectados, barH };
}

// =====================
// Imagen final (con 2 franjas arriba)
// =====================
function generarImagenResumenBuffer({ fecha, mes, cantidadDia, cantidadMes, monitoreo, metricas }) {
    const width = 900;
    const height = 520; // + franja de métricas
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    const nf = new Intl.NumberFormat("es-AR");
    const cantidadDiaFmt = nf.format(Number(cantidadDia));
    const cantidadMesFmt = nf.format(Number(cantidadMes));

    // Fondo
    ctx.fillStyle = "#0b1220";
    ctx.fillRect(0, 0, width, height);

    // Franja 1 (micros)
    const status = drawStatusBarTop(ctx, width, monitoreo);
    const topBarH = status.barH || 62;

    // Franja 2 (métricas)
    const metricsBar = drawMetricsBar(ctx, width, topBarH, metricas);
    const metricsBarH = metricsBar.barH || 52;

    const topOffset = topBarH + metricsBarH;

    // Card principal
    const cardX = 40;
    const cardY = topOffset + 20;
    const cardW = width - 80;
    const cardH = height - cardY - 40;

    ctx.fillStyle = "#111b2e";
    ctx.fillRect(cardX, cardY, cardW, cardH);

    const year = String(fecha).slice(0, 4);
    const monthName = monthNameEsFromFecha(fecha);

    ctx.fillStyle = "#cbd5e1";
    ctx.font = 'bold 44px "DejaVuSans"';
    const monthW = ctx.measureText(monthName).width;
    ctx.fillText(monthName, cardX + cardW / 2 - monthW / 2, cardY + 95);

    ctx.fillStyle = "#1f2a44";
    ctx.fillRect(cardX + 40, cardY + 120, cardW - 80, 2);

    const leftX = cardX + 60;
    const rightX = cardX + 480;
    const baseY = cardY + 250;

    ctx.fillStyle = "#ffffff";
    ctx.font = 'bold 66px "DejaVuSans"';
    ctx.fillText(cantidadDiaFmt, leftX, baseY);

    ctx.fillStyle = "#cbd5e1";
    ctx.font = '22px "DejaVuSans"';
    ctx.fillText("Total del día", leftX, baseY + 35);

    ctx.fillStyle = "#ffffff";
    ctx.font = 'bold 52px "DejaVuSans"';
    ctx.fillText(cantidadMesFmt, rightX, baseY);

    ctx.fillStyle = "#cbd5e1";
    ctx.font = '22px "DejaVuSans"';
    ctx.fillText("Total del mes", rightX, baseY + 35);

    ctx.fillStyle = "#94a3b8";
    ctx.font = 'bold 32px "DejaVuSans"';
    const yearW = ctx.measureText(year).width;
    ctx.fillText(year, cardX + cardW / 2 - yearW / 2, cardY + cardH - 35);

    const buf = canvas.toBuffer("image/png");
    return { buf, status, metricsSeverity: metricsBar.sev };
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

    const resp = await axios.post("https://files.lightdata.app/sat/guardarFotosSAT.php", payload, {
        timeout: 200000,
        headers: { "Content-Type": "application/json" },
        responseType: "text",
        transformResponse: (r) => r,
    });

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

    if (!dia) return res.status(400).json({ ok: false, msg: "Faltan parámetros: dia" });
    if (!token) return res.status(400).json({ ok: false, msg: "Faltan parámetros: token" });

    try {
        const { fecha, mes, cantidadDia, cantidadMes, monitoreo } = await obtenerCantidad(dia);

        // NUEVO: métricas conjunto
        const metricas = await obtenerMetricasConjunto();

        // Hash lógico (incluye monitoreo + severidad métricas)
        const registros = monitoreo?.data ?? [];
        const { maxStreak, afectados } = computeConsecutiveFails(registros);

        const sev = computeMetricsSeverity(metricas);

        const logicalPayload = {
            fecha: String(fecha),
            mes: String(mes),
            cantidadDia: Number(cantidadDia),
            cantidadMes: Number(cantidadMes),
            maxStreak,
            afectados: afectados.map((x) => ({ micro: x.micro, streak: x.streak })),
            metricas: {
                usoCpu: metricas?.usoCpu ?? null,
                usoRam: metricas?.usoRam ?? null,
                usoDisco: metricas?.usoDisco ?? null,
                overCount: sev.overCount,
            },
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

        // Imagen
        const { buf: bufferPng, status, metricsSeverity } = generarImagenResumenBuffer({
            fecha,
            mes,
            cantidadDia,
            cantidadMes,
            monitoreo,
            metricas,
        });

        const safeFecha = String(fecha).replace(/[^0-9a-zA-Z_-]/g, "-");
        const nombreSAT = (nombre && String(nombre)) || `resumen_${safeFecha}_${Date.now()}.png`;

        const imageUrl = await subirImagenSAT({ bufferPng, nombre: nombreSAT });

        const message = {
            token,
            data: {
                imageUrl,
                fecha: String(fecha),
                mes: String(mes),
                cantidadDia: String(cantidadDia),
                cantidadMes: String(cantidadMes),

                // micros
                maxStreak: String(status?.maxStreak ?? 0),
                afectados: JSON.stringify(status?.afectados ?? []),

                // métricas (para el cliente si querés)
                metricLevel: String(metricsSeverity?.level ?? "OK"),
                metricOverCount: String(metricsSeverity?.overCount ?? 0),

                ...(titulo ? { titulo: String(titulo) } : {}),
                ...(cuerpo ? { cuerpo: String(cuerpo) } : {}),
            },
            android: {
                notification: { imageUrl },
                channelId: "silent_high",
                priority: "HIGH",
            },
        };

        const fcmResponse = await admin.messaging().send(message);

        await setLastHash(token, currentHash);

        return res.json({
            ok: true,
            fecha,
            mes,
            cantidadDia,
            cantidadMes,
            imageUrl,
            status,
            metricas,
            metricsSeverity,
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
    const { fecha, mes, cantidadDia, cantidadMes, monitoreo } = await obtenerCantidad(dia);
    const metricas = await obtenerMetricasConjunto();

    const registros = monitoreo?.data ?? [];
    const { maxStreak, afectados } = computeConsecutiveFails(registros);

    const sev = computeMetricsSeverity(metricas);

    const logicalPayload = {
        fecha: String(fecha),
        mes: String(mes),
        cantidadDia: Number(cantidadDia),
        cantidadMes: Number(cantidadMes),
        maxStreak,
        afectados: afectados.map((x) => ({ micro: x.micro, streak: x.streak })),
        metricas: {
            usoCpu: metricas?.usoCpu ?? null,
            usoRam: metricas?.usoRam ?? null,
            usoDisco: metricas?.usoDisco ?? null,
            overCount: sev.overCount,
        },
    };

    const currentHash = sha256(stableStringify(logicalPayload));
    const lastHash = await getLastHash(token);

    if (lastHash && lastHash === currentHash) {
        console.log("Sin cambios: no se envía notificación (se mantiene la anterior).");
        return { skipped: true };
    }

    const { buf: bufferPng, status, metricsSeverity } = generarImagenResumenBuffer({
        fecha,
        mes,
        cantidadDia,
        cantidadMes,
        monitoreo,
        metricas,
    });

    const safeFecha = String(fecha).replace(/[^0-9a-zA-Z_-]/g, "-");
    const nombreSAT = `resumen_${safeFecha}_${Date.now()}.png`;

    const imageUrl = await subirImagenSAT({ bufferPng, nombre: nombreSAT });

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
            metricLevel: String(metricsSeverity?.level ?? "OK"),
            metricOverCount: String(metricsSeverity?.overCount ?? 0),
        },
        android: {
            // notification: { imageUrl },
            priority: "HIGH",
        },
    };

    const resp = await admin.messaging().send(message);
    await setLastHash(token, currentHash);

    return resp;
}
