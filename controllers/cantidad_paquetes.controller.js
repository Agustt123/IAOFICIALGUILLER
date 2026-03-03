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

    if (!data?.ok) throw new Error(`Respuesta inválida de /cantidad: ${JSON.stringify(data)}`);
    if (!dataServidores?.estado || !Array.isArray(dataServidores?.data))
        throw new Error(`Respuesta inválida de /monitoreo: ${JSON.stringify(dataServidores)}`);

    // Compat nombres viejos/nuevos:
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
// Métricas conjunto
// =====================
function toNum(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).trim().replace("%", "").replace(",", ".");
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

export async function obtenerMetricasConjunto() {
    const { data } = await axios.get("https://dw.lightdata.app/monitoreo/metricas", {
        timeout: 15000,
    });

    if (!data?.estado || !Array.isArray(data?.data?.rows) || data.data.rows.length === 0) {
        throw new Error(`Respuesta inválida de /monitoreo/metricas: ${JSON.stringify(data)}`);
    }

    const rows = data.data.rows;

    // ✅ agarrar la fila correcta aunque el orden cambie
    const row =
        rows.find(r =>
            String(r.servidor).toLowerCase() === "conjunto" &&
            String(r.endpoint).toUpperCase() === "ALL"
        ) ||
        rows.find(r => String(r.servidor).toLowerCase() === "conjunto") ||
        rows[0] ||
        {};

    // ✅ DEVOLVÉ TAMBIÉN EL RAW para debug
    return {
        did: Number(data.data.did ?? row.did ?? 0) || null,
        usoCpu: toNum(row.usoCpu),
        usoRam: toNum(row.usoRam),
        usoDisco: toNum(row.usoDisco),
        carga1m: toNum(row.carga1m),
        latenciaMs: toNum(row.latenciaMs),
        _raw: row, // <- clave para comparar
    };
}
// =====================
// Severidad global por métricas y micros (barra superior)
// Umbrales métricas:
//  <50 verde | 50-69 amarillo | 70-79 naranja | >=80 rojo
// Micros (maxStreak):
//  0 verde | 1 amarillo | 2 naranja | >=3 rojo
// =====================
function severityRank(s) {
    if (s === "rojo") return 3;
    if (s === "naranja") return 2;
    if (s === "amarillo") return 1;
    return 0; // verde
}

function pickWorstSeverity(a, b) {
    return severityRank(a) >= severityRank(b) ? a : b;
}

function severityFromMetricMax(pctMax) {
    const v = Number(pctMax);
    if (!Number.isFinite(v)) return "amarillo"; // desconocido => alerta leve
    if (v >= 80) return "rojo";
    if (v >= 70) return "naranja";
    if (v >= 50) return "amarillo";
    return "verde";
}

function severityFromMaxStreak(maxStreak) {
    const s = Number(maxStreak) || 0;
    if (s >= 3) return "rojo";
    if (s === 2) return "naranja";
    if (s === 1) return "amarillo";
    return "verde";
}

function severityStyle(sev) {
    if (sev === "rojo") return { bg: "#dc2626", fg: "#ffffff", label: "CRÍTICO" };
    if (sev === "naranja") return { bg: "#f97316", fg: "#111827", label: "ALTO" };
    if (sev === "amarillo") return { bg: "#facc15", fg: "#111827", label: "ATENCIÓN" };
    return { bg: "#22c55e", fg: "#052e16", label: "TODO OK" };
}

// =====================
// UI helpers
// =====================
function monthNameEsFromFecha(fechaYYYYMMDD) {
    const d = new Date(`${fechaYYYYMMDD}T00:00:00Z`);
    const fmt = new Intl.DateTimeFormat("es-AR", { month: "long" });
    const name = fmt.format(d);
    return name.charAt(0).toUpperCase() + name.slice(1);
}

function fmtPct(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return "--";
    return `${Math.round(n)}%`;
}

function metricColorByPct(pct) {
    const v = Number(pct);
    if (!Number.isFinite(v)) return "#94a3b8"; // desconocido
    if (v >= 80) return "#dc2626"; // rojo
    if (v >= 70) return "#f97316"; // naranja
    if (v >= 50) return "#facc15"; // amarillo
    return "#cbd5e1"; // normal
}

// Ajusta font para que el texto entre en un ancho máximo
function fitFontPxForText(ctx, text, maxWidth, startPx, minPx, fontFamily, weight = "bold") {
    let px = startPx;
    while (px > minPx) {
        ctx.font = `${weight} ${px}px "${fontFamily}"`;
        if (ctx.measureText(text).width <= maxWidth) return px;
        px -= 2;
    }
    return minPx;
}

// =====================
// Barra superior (color por severidad)
// =====================
function drawStatusBarTop(ctx, width, monitoreo, metricas) {
    const registros = monitoreo?.data ?? [];
    const { maxStreak, afectados } = computeConsecutiveFails(registros);

    const cpu = toNum(metricas?.usoCpu);
    const ram = toNum(metricas?.usoRam);
    const disk = toNum(metricas?.usoDisco);

    const vals = [cpu, ram, disk].filter((v) => v !== null);
    const pctMax = vals.length ? Math.max(...vals) : null;

    // cuál fue el max (CPU/RAM/DISCO)
    let pctMaxName = null;
    if (vals.length) {
        const pairs = [
            { k: "CPU", v: cpu },
            { k: "RAM", v: ram },
            { k: "DISCO", v: disk },
        ].filter((p) => p.v !== null);
        pairs.sort((a, b) => (b.v ?? -1) - (a.v ?? -1));
        pctMaxName = pairs[0]?.k ?? null;
    }

    const metricSev = severityFromMetricMax(pctMax);
    const microsSev = severityFromMaxStreak(maxStreak);

    const sev = pickWorstSeverity(metricSev, microsSev);
    const style = severityStyle(sev);

    const barH = 62;
    const y = 0;

    ctx.fillStyle = style.bg;
    ctx.fillRect(0, y, width, barH);

    ctx.fillStyle = style.fg;
    ctx.font = 'bold 22px "DejaVuSans"';

    const title = sev === "verde" ? "TODO OK" : `⚠️ ${style.label}`;
    ctx.fillText(title, 22, y + 40);

    const parts = [];
    if (pctMaxName && pctMax !== null) parts.push(`${pctMaxName} ${Math.round(pctMax)}%`);
    if (maxStreak > 0 && afectados.length) {
        const list = afectados.slice(0, 6).map((x) => `${x.micro}(${x.streak})`).join(", ");
        parts.push(list);
    }

    if (parts.length) {
        ctx.font = '18px "DejaVuSans"';
        ctx.fillText(parts.join(" | "), 180, y + 40);
    }

    return { maxStreak, afectados, barH, sev, pctMax, pctMaxName };
}

// =====================
// Imagen final
// - Año arriba centrado
// - 3 mini-cards para separar (Hoy / Mes / Mov. hoy)
// - Auto-fit de fuente para que no se pisen
// - Línea abajo con CPU/RAM/DISCO con color por umbral
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
    const height = 560;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    const nf = new Intl.NumberFormat("es-AR");
    const hoyFmt = nf.format(Number(cantidadDia));
    const mesFmt = nf.format(Number(cantidadMes));
    const movFmt = nf.format(Number(hoyMovimiento));

    // Fondo
    ctx.fillStyle = "#0b1220";
    ctx.fillRect(0, 0, width, height);

    // Barra superior
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

    // Año centrado
    ctx.fillStyle = "#cbd5e1";
    ctx.font = 'bold 44px "DejaVuSans"';
    const yearW = ctx.measureText(year).width;
    ctx.fillText(year, cardX + cardW / 2 - yearW / 2, cardY + 85);

    // Separador
    ctx.fillStyle = "#1f2a44";
    ctx.fillRect(cardX + 40, cardY + 110, cardW - 80, 2);

    // Mini-cards (3 columnas)
    const innerX = cardX + 40;
    const innerY = cardY + 140;
    const innerW = cardW - 80;
    const innerH = 220;

    const gap = 18;
    const colW = (innerW - gap * 2) / 3;

    const cols = [
        { label: "Hoy", value: hoyFmt },
        { label: monthName, value: mesFmt },
        { label: "Mov. hoy", value: movFmt },
    ];

    for (let i = 0; i < cols.length; i++) {
        const x = innerX + i * (colW + gap);
        const y = innerY;

        // fondo mini-card para separar visualmente
        ctx.fillStyle = "#0f1a2c";
        ctx.fillRect(x, y, colW, innerH);

        // label
        ctx.fillStyle = "#cbd5e1";
        ctx.font = 'bold 22px "DejaVuSans"';
        ctx.fillText(cols[i].label, x + 20, y + 55);

        // value (auto-fit)
        const maxTextW = colW - 40;
        const fontPx = fitFontPxForText(ctx, cols[i].value, maxTextW, 60, 34, "DejaVuSans", "bold");
        ctx.fillStyle = "#ffffff";
        ctx.font = `bold ${fontPx}px "DejaVuSans"`;
        ctx.fillText(cols[i].value, x + 20, y + 140);

        // separador vertical suave (derecha)
        if (i < cols.length - 1) {
            ctx.fillStyle = "#111b2e";
            ctx.fillRect(x + colW + gap / 2 - 1, y + 10, 2, innerH - 20);
        }
    }

    // Línea inferior CPU/RAM/DISCO
    const cpu = metricas?.usoCpu;
    const ram = metricas?.usoRam;
    const disk = metricas?.usoDisco;

    const infoY = cardY + cardH - 45;
    ctx.font = 'bold 22px "DejaVuSans"';

    const parts = [
        { label: "CPU", val: cpu },
        { label: "RAM", val: ram },
        { label: "DISCO", val: disk },
    ];

    // medir centrado
    const sep = "  •  ";
    const sepW = ctx.measureText(sep).width;

    const rendered = parts.map((p) => {
        const text = `${p.label} ${fmtPct(p.val)}`;
        const w = ctx.measureText(text).width;
        return { ...p, text, w };
    });

    let totalW = rendered.reduce((acc, r) => acc + r.w, 0) + sepW * (rendered.length - 1);
    let x0 = cardX + cardW / 2 - totalW / 2;

    for (let i = 0; i < rendered.length; i++) {
        const r = rendered[i];
        ctx.fillStyle = metricColorByPct(r.val);
        ctx.fillText(r.text, x0, infoY);
        x0 += r.w;

        if (i < rendered.length - 1) {
            ctx.fillStyle = "#64748b";
            ctx.fillText(sep, x0, infoY);
            x0 += sepW;
        }
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

        const registros = monitoreo?.data ?? [];
        const { maxStreak, afectados } = computeConsecutiveFails(registros);

        const cpu = toNum(metricas?.usoCpu);
        const ram = toNum(metricas?.usoRam);
        const disk = toNum(metricas?.usoDisco);
        const vals = [cpu, ram, disk].filter((v) => v !== null);
        const pctMax = vals.length ? Math.max(...vals) : null;

        const metricSev = severityFromMetricMax(pctMax);
        const microsSev = severityFromMaxStreak(maxStreak);
        const sev = pickWorstSeverity(metricSev, microsSev);
        console.log("METRICAS RAW:", metricas?._raw);
        console.log("METRICAS PARSED:", { cpu: metricas.usoCpu, ram: metricas.usoRam, disco: metricas.usoDisco });
        // ✅ Hash: "de a miles" + severidad + afectados
        const logicalPayload = {
            fecha: String(fecha),
            mes: String(mes),

            hoyBucket: bucket1000(cantidadDia),
            mesBucket: bucket1000(cantidadMes),
            hoyMovBucket: bucket1000(hoyMovimiento),

            sev,
            maxStreak,
            afectados: afectados.map((x) => ({ micro: x.micro, streak: x.streak })),

            metricas: {
                usoCpu: cpu,
                usoRam: ram,
                usoDisco: disk,
                pctMax,
            },
        };

        const currentHash = sha256(stableStringify(logicalPayload));
        const lastHash = await getLastHash(token);

        if (lastHash && lastHash === currentHash) {
            return res.json({
                ok: true,
                skipped: true,
                msg: "Sin cambios relevantes (a miles / severidad): no se envía notificación.",
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

                // status
                sev: String(status?.sev ?? "verde"),
                maxStreak: String(status?.maxStreak ?? 0),
                afectados: JSON.stringify(status?.afectados ?? []),

                // métricas
                usoCpu: String(cpu ?? ""),
                usoRam: String(ram ?? ""),
                usoDisco: String(disk ?? ""),
                pctMax: String(pctMax ?? ""),

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

    const cpu = toNum(metricas?.usoCpu);
    const ram = toNum(metricas?.usoRam);
    const disk = toNum(metricas?.usoDisco);
    const vals = [cpu, ram, disk].filter((v) => v !== null);
    const pctMax = vals.length ? Math.max(...vals) : null;

    const metricSev = severityFromMetricMax(pctMax);
    const microsSev = severityFromMaxStreak(maxStreak);
    const sev = pickWorstSeverity(metricSev, microsSev);

    const logicalPayload = {
        fecha: String(fecha),
        mes: String(mes),

        hoyBucket: bucket1000(cantidadDia),
        mesBucket: bucket1000(cantidadMes),
        hoyMovBucket: bucket1000(hoyMovimiento),

        sev,
        maxStreak,
        afectados: afectados.map((x) => ({ micro: x.micro, streak: x.streak })),

        metricas: {
            usoCpu: cpu,
            usoRam: ram,
            usoDisco: disk,
            pctMax,
        },
    };

    const currentHash = sha256(stableStringify(logicalPayload));
    const lastHash = await getLastHash(token);

    if (lastHash && lastHash === currentHash) {
        console.log("Sin cambios relevantes (a miles / severidad): no se envía notificación.");
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

            sev: String(status?.sev ?? "verde"),
            maxStreak: String(status?.maxStreak ?? 0),
            afectados: JSON.stringify(status?.afectados ?? []),

            usoCpu: String(cpu ?? ""),
            usoRam: String(ram ?? ""),
            usoDisco: String(disk ?? ""),
            pctMax: String(pctMax ?? ""),
        },
        android: {
            priority: "HIGH",
        },
    };

    const resp = await admin.messaging().send(message);
    await setLastHash(token, currentHash);

    return { ok: true, resp, imageUrl, logicalPayload };
}