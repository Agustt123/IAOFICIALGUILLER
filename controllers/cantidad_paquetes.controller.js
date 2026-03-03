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
// Buckets "de a miles" para evitar spam
// =====================
function bucket1000(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return null;
    return Math.floor(x / 1000); // 0,1,2...
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

    // Compat nombres viejos/nuevos:
    // - hoy / mesCantidad / hoyMovimiento (nuevo)
    // - cantidadDia / cantidadMes (viejo)
    // - cantidad (fallback)
    const cantidadDia = Number(data.hoy ?? data.cantidadDia ?? data.cantidad ?? 0);
    const cantidadMes = Number(data.mesCantidad ?? data.cantidadMes ?? 0);
    const hoyMovimiento = Number(data.hoyMovimiento ?? 0);

    return {
        fecha: data.fecha ?? diaFinal,
        mes: data.mes ?? String(diaFinal).slice(0, 7),
        cantidadDia,
        cantidadMes,
        hoyMovimiento,
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
// Semáforo de métricas
// - OK: 0 >=80
// - ATENCIÓN: 1 >=80
// - ALTO: 2 >=80
// - CRÍTICO: 3 >=80
// =====================
const METRIC_WARN_PCT = 80;

function computeMetricsSeverity(metricas) {
    const vals = [metricas?.usoCpu, metricas?.usoRam, metricas?.usoDisco]
        .map((v) => toNum(v))
        .filter((v) => v !== null);

    const over = vals.filter((v) => v >= METRIC_WARN_PCT).length;

    if (over >= 3) return { level: "CRÍTICO", overCount: over };
    if (over === 2) return { level: "ALTO", overCount: over };
    if (over === 1) return { level: "ATENCIÓN", overCount: over };
    return { level: "OK", overCount: over };
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

// =====================
// Barra superior (SIEMPRE VERDE) + aviso si falla algo
// (sacamos la línea finita, y no hay franja negra)
// =====================
function drawStatusBarTop(ctx, width, monitoreo, metricas) {
    const registros = monitoreo?.data ?? [];
    const { maxStreak, afectados } = computeConsecutiveFails(registros);

    const sev = computeMetricsSeverity(metricas);
    const hayFalla = maxStreak > 0 || sev.overCount > 0;

    const barH = 62;
    const y = 0;

    // ✅ siempre verde
    ctx.fillStyle = "#22c55e";
    ctx.fillRect(0, y, width, barH);

    // Texto
    ctx.fillStyle = "#052e16";
    ctx.font = 'bold 22px "DejaVuSans"';

    const title = hayFalla ? "⚠️ FALLA" : "TODO OK";
    ctx.fillText(title, 22, y + 40);

    if (hayFalla) {
        const partes = [];

        if (maxStreak > 0 && afectados.length > 0) {
            const list = afectados
                .slice(0, 8)
                .map((x) => `${x.micro}(${x.streak})`)
                .join(", ");
            partes.push(list);
        }

        if (sev.overCount > 0) {
            partes.push(`Métricas>=80: ${sev.overCount}`);
        }

        ctx.font = '18px "DejaVuSans"';
        ctx.fillText(partes.join(" | "), 180, y + 40);
    }

    return { maxStreak, afectados, barH, sev, hayFalla };
}

// =====================
// Imagen final (1 franja arriba, tarjeta con 3 métricas)
// Layout pedido:
// - arriba centro: AÑO
// - 3 columnas: (label arriba / número abajo)
//   Hoy / Mes (Marzo) / HoyMovimiento
// =====================
function generarImagenResumenBuffer({
    fecha,
    cantidadDia,
    cantidadMes,
    hoyMovimiento,
    monitoreo,
    metricas,
}) {
    const width = 900;
    const height = 520;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    const nf = new Intl.NumberFormat("es-AR");
    const hoyFmt = nf.format(Number(cantidadDia));
    const mesFmt = nf.format(Number(cantidadMes));
    const movFmt = nf.format(Number(hoyMovimiento));

    // Fondo
    ctx.fillStyle = "#0b1220";
    ctx.fillRect(0, 0, width, height);

    // Franja (verde)
    const status = drawStatusBarTop(ctx, width, monitoreo, metricas);
    const topOffset = status.barH || 62;

    // Card principal
    const cardX = 40;
    const cardY = topOffset + 20;
    const cardW = width - 80;
    const cardH = height - cardY - 40;

    ctx.fillStyle = "#111b2e";
    ctx.fillRect(cardX, cardY, cardW, cardH);

    const year = String(fecha).slice(0, 4);
    const monthName = monthNameEsFromFecha(fecha);

    // ✅ Año arriba centrado (donde antes iba el mes)
    ctx.fillStyle = "#cbd5e1";
    ctx.font = 'bold 44px "DejaVuSans"';
    const yearW = ctx.measureText(year).width;
    ctx.fillText(year, cardX + cardW / 2 - yearW / 2, cardY + 95);

    // Separador
    ctx.fillStyle = "#1f2a44";
    ctx.fillRect(cardX + 40, cardY + 120, cardW - 80, 2);

    // ✅ 3 columnas
    const cols = [
        { label: "Hoy", value: hoyFmt },
        { label: monthName, value: mesFmt },
        { label: "Hoy mov.", value: movFmt }, // abreviado para que entre lindo
    ];

    const startX = cardX + 60;
    const innerW = cardW - 120;
    const colW = innerW / 3;

    const labelY = cardY + 205;
    const valueY = cardY + 290;

    for (let i = 0; i < cols.length; i++) {
        const x = startX + i * colW;

        // label
        ctx.fillStyle = "#cbd5e1";
        ctx.font = 'bold 24px "DejaVuSans"';
        ctx.fillText(cols[i].label, x, labelY);

        // value
        ctx.fillStyle = "#ffffff";
        ctx.font = 'bold 58px "DejaVuSans"';
        ctx.fillText(cols[i].value, x, valueY);
    }

    const buf = canvas.toBuffer("image/png");
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
        const { fecha, mes, cantidadDia, cantidadMes, monitoreo, hoyMovimiento } =
            await obtenerCantidad(dia);

        const metricas = await obtenerMetricasConjunto();

        // Estado de fallas
        const registros = monitoreo?.data ?? [];
        const { maxStreak, afectados } = computeConsecutiveFails(registros);
        const sev = computeMetricsSeverity(metricas);

        const failMicros = maxStreak > 0;
        const failMetricas = sev.overCount > 0;

        // ✅ Hash "de a miles" + fallas
        const logicalPayload = {
            fecha: String(fecha),
            mes: String(mes),

            hoyBucket: bucket1000(cantidadDia),
            mesBucket: bucket1000(cantidadMes),
            hoyMovBucket: bucket1000(hoyMovimiento),

            failMicros,
            failMetricas,

            maxStreak,
            afectados: afectados.map((x) => ({ micro: x.micro, streak: x.streak })),
            metricas: { overCount: sev.overCount },
        };

        const currentHash = sha256(stableStringify(logicalPayload));
        const lastHash = await getLastHash(token);

        if (lastHash && lastHash === currentHash) {
            return res.json({
                ok: true,
                skipped: true,
                msg: "Sin cambios relevantes (a miles / fallas): no se envía notificación.",
                logicalPayload,
            });
        }

        // Imagen
        const { buf: bufferPng, status } = generarImagenResumenBuffer({
            fecha,
            cantidadDia,
            cantidadMes,
            hoyMovimiento,
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
                hoyMovimiento: String(hoyMovimiento),

                // micros
                maxStreak: String(status?.maxStreak ?? 0),
                afectados: JSON.stringify(status?.afectados ?? []),

                // métricas
                metricOverCount: String(status?.sev?.overCount ?? 0),
                metricLevel: String(status?.sev?.level ?? "OK"),

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
            hoyMovimiento,
            imageUrl,
            status,
            metricas,
            fcmResponse,
            logicalPayload,
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
    const { fecha, mes, cantidadDia, cantidadMes, monitoreo, hoyMovimiento } =
        await obtenerCantidad(dia);

    const metricas = await obtenerMetricasConjunto();

    const registros = monitoreo?.data ?? [];
    const { maxStreak, afectados } = computeConsecutiveFails(registros);
    const sev = computeMetricsSeverity(metricas);

    const failMicros = maxStreak > 0;
    const failMetricas = sev.overCount > 0;

    const logicalPayload = {
        fecha: String(fecha),
        mes: String(mes),

        hoyBucket: bucket1000(cantidadDia),
        mesBucket: bucket1000(cantidadMes),
        hoyMovBucket: bucket1000(hoyMovimiento),

        failMicros,
        failMetricas,

        maxStreak,
        afectados: afectados.map((x) => ({ micro: x.micro, streak: x.streak })),
        metricas: { overCount: sev.overCount },
    };

    const currentHash = sha256(stableStringify(logicalPayload));
    const lastHash = await getLastHash(token);

    if (lastHash && lastHash === currentHash) {
        console.log("Sin cambios relevantes (a miles / fallas): no se envía notificación.");
        return { skipped: true, logicalPayload };
    }

    const { buf: bufferPng, status } = generarImagenResumenBuffer({
        fecha,
        cantidadDia,
        cantidadMes,
        hoyMovimiento,
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
            hoyMovimiento: String(hoyMovimiento),

            maxStreak: String(status?.maxStreak ?? 0),
            afectados: JSON.stringify(status?.afectados ?? []),

            metricOverCount: String(status?.sev?.overCount ?? 0),
            metricLevel: String(status?.sev?.level ?? "OK"),
        },
        android: {
            priority: "HIGH",
        },
    };

    const resp = await admin.messaging().send(message);
    await setLastHash(token, currentHash);

    return { ok: true, resp, imageUrl, logicalPayload };
}