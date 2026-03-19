import axios from "axios";
import admin from "firebase-admin";
import { createCanvas, registerFont } from "canvas";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { eliminarDispositivoPorToken } from "./device.controller.js";

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

function isInvalidFcmTokenError(error) {
    const code = String(error?.code || "");
    return (
        code === "messaging/registration-token-not-registered" ||
        code === "messaging/invalid-registration-token"
    );
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

    const cantidadDia = Number(data.hoy ?? data.cantidadDia ?? data.cantidad ?? 0);
    const cantidadMes = Number(data.mesCantidad ?? data.cantidadMes ?? 0);

    // ✅ NUEVO
    const anioCantidad = Number(data.añoCantidad ?? data.anioCantidad ?? 0);

    return {
        fecha: data.fecha ?? diaFinal,
        mes: data.mes ?? String(diaFinal).slice(0, 7),
        cantidadDia,
        cantidadMes,
        anioCantidad,
        mesNombre: data.nombre, // si lo seguís usando en otro lado
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
    const { data } = await axios.get("https://dw.lightdata.app/monitoreo/metricas", { timeout: 15000 });

    if (!data?.estado || !Array.isArray(data?.data?.rows) || data.data.rows.length === 0) {
        throw new Error(`Respuesta inválida de /monitoreo/metricas: ${JSON.stringify(data)}`);
    }

    const rows = data.data.rows;

    const row =
        rows.find(r => String(r.servidor).toLowerCase() === "conjunto" && String(r.endpoint).toUpperCase() === "ALL") ||
        rows.find(r => String(r.servidor).toLowerCase() === "conjunto") ||
        rows[0] ||
        {};

    return {
        did: Number(data.data.did ?? row.did ?? 0) || null,

        usoCpu: toNum(row.usoCpu),
        usoRam: toNum(row.usoRam),
        usoDisco: toNum(row.usoDisco),

        latenciaMs: toNum(row.latenciaMs),
        carga1m: toNum(row.carga1m),

        ramProcesoMb: toNum(row.ramProcesoMb),
        cpuProceso: toNum(row.cpuProceso),

        temperaturaCpu: toNum(row.temperaturaCpu),

        codigoHttp: row.codigoHttp ?? null,
        error: row.error ?? null,

        _raw: row,
    };
}

export async function obtenerProcesosConjunto() {
    const { data } = await axios.get("https://dw.lightdata.app/monitoreo/procesos-conjunto", {
        timeout: 15000,
    });

    if (!data?.estado || !Array.isArray(data?.data?.todos)) {
        throw new Error(`Respuesta inválida de /monitoreo/procesos-conjunto: ${JSON.stringify(data)}`);
    }

    return data.data.todos.map((row) => ({
        servidor: String(row.servidor || "desconocido"),
        ok: Number(row.ok ?? 0) === 1,
        codigoHttp: Number(row.codigoHttp ?? 0) || null,
        latenciaMs: toNum(row.latenciaMs),
        error: row.error ? String(row.error) : null,
        procesos: Number(row.procesos ?? 0) || 0,
        totalSegundos: toNum(row.total_segundos),
        promedioSegundos: toNum(row.promedio_segundos),
        maxSegundos: toNum(row.max_segundos),
        _raw: row,
    }));
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

function shortSecondsLabel(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return "--";
    if (n >= 10) return `${Math.round(n)}s`;
    return `${n.toFixed(1)}s`;
}

function satSeverityColor(sev) {
    if (sev === "rojo") return "#dc2626";
    if (sev === "naranja") return "#f97316";
    if (sev === "amarillo") return "#facc15";
    return "#22c55e";
}

function isSatConjuntoRow(row) {
    return String(row?.servidor || "").toLowerCase() === "conjunto";
}

function severityFromSatRow(row) {
    if (!row.ok || row.error || (row.codigoHttp !== null && row.codigoHttp >= 500)) {
        return "rojo";
    }
    const procesos = Number(row.procesos ?? 0);
    const maxSeg = Number(row.maxSegundos ?? 0);
    const avgSeg = Number(row.promedioSegundos ?? 0);
    const latMs = Number(row.latenciaMs ?? 0);
    const isConjunto = isSatConjuntoRow(row);

    if (maxSeg >= 15) return "rojo";
    if (!isConjunto && procesos >= 8) return "rojo";

    if (maxSeg >= 8 || avgSeg >= 5) return "naranja";
    if (!isConjunto && procesos >= 5) return "naranja";
    if (isConjunto && procesos >= 20 && maxSeg >= 2) return "naranja";

    if (maxSeg >= 4 || avgSeg >= 2 || latMs >= 1500) return "amarillo";
    if (!isConjunto && procesos >= 3) return "amarillo";
    if (isConjunto && procesos >= 15 && maxSeg >= 1) return "amarillo";

    return "verde";
}

function satReasonForRow(row, sev) {
    if (!row.ok) return "ERROR";
    if (row.error) return "ERROR";
    if (row.codigoHttp !== null && row.codigoHttp >= 500) return `HTTP ${row.codigoHttp}`;
    if (sev === "rojo" || sev === "naranja") {
        if ((row.maxSegundos ?? 0) > 0) return `MAX ${shortSecondsLabel(row.maxSegundos)}`;
        if ((row.promedioSegundos ?? 0) > 0) return `AVG ${shortSecondsLabel(row.promedioSegundos)}`;
        if (!isSatConjuntoRow(row) && row.procesos > 0) return `PROC ${row.procesos}`;
    }
    if (!isSatConjuntoRow(row) && row.procesos >= 3) return `PROC ${row.procesos}`;
    if ((row.latenciaMs ?? 0) >= 1500) return `LAT ${Math.round(row.latenciaMs)}ms`;
    if ((row.maxSegundos ?? 0) > 0) return `MAX ${shortSecondsLabel(row.maxSegundos)}`;
    if (isSatConjuntoRow(row) && row.procesos > 0) return `TOTAL ${row.procesos}`;
    return "OK";
}

function analyzeSatProcesos(rows) {
    const normalized = Array.isArray(rows) ? rows : [];
    const incidents = normalized.map((row) => {
        const sev = severityFromSatRow(row);
        return {
            servidor: row.servidor,
            sev,
            reason: satReasonForRow(row, sev),
            procesos: row.procesos,
            promedioSegundos: row.promedioSegundos,
            maxSegundos: row.maxSegundos,
            latenciaMs: row.latenciaMs,
            ok: row.ok,
            codigoHttp: row.codigoHttp,
            error: row.error,
        };
    });

    incidents.sort((a, b) =>
        severityRank(b.sev) - severityRank(a.sev) ||
        (b.maxSegundos ?? 0) - (a.maxSegundos ?? 0) ||
        (b.procesos ?? 0) - (a.procesos ?? 0) ||
        a.servidor.localeCompare(b.servidor)
    );

    const affected = incidents.filter((x) => x.sev !== "verde");
    const sev = affected.reduce((acc, x) => pickWorstSeverity(acc, x.sev), "verde");
    const top = (affected.length ? affected : incidents).slice(0, 3);
    const summaryText = affected.length
        ? top.map((x) => `${x.servidor} ${x.reason}`).join(" | ")
        : `SAT OK ${normalized.length}/${normalized.length}`;

    return {
        sev,
        total: normalized.length,
        affectedCount: affected.length,
        okCount: incidents.filter((x) => x.ok).length,
        incidents,
        affected,
        top,
        summaryText,
    };
}

async function obtenerSatProcesosInfoSafe() {
    try {
        const satProcesos = await obtenerProcesosConjunto();
        return analyzeSatProcesos(satProcesos);
    } catch (error) {
        return {
            sev: "rojo",
            total: 0,
            affectedCount: 1,
            okCount: 0,
            incidents: [],
            affected: [{
                servidor: "sat",
                sev: "rojo",
                reason: "ERROR",
                procesos: 0,
                promedioSegundos: null,
                maxSegundos: null,
                latenciaMs: null,
                ok: false,
                codigoHttp: null,
                error: String(error?.message || error),
            }],
            top: [{
                servidor: "sat",
                sev: "rojo",
                reason: "ERROR",
                procesos: 0,
                promedioSegundos: null,
                maxSegundos: null,
                latenciaMs: null,
                ok: false,
                codigoHttp: null,
                error: String(error?.message || error),
            }],
            summaryText: "sat ERROR",
        };
    }
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
function drawStatusBarTop(ctx, width, monitoreo, metricas, satProcesosInfo) {
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
    const satSev = satProcesosInfo?.sev ?? "verde";
    const sev = pickWorstSeverity(pickWorstSeverity(metricSev, microsSev), satSev);
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
    if (satProcesosInfo?.affectedCount) {
        parts.push(`SAT ${satProcesosInfo.summaryText}`);
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
    anioCantidad,
    monitoreo,
    metricas,
    satProcesosInfo,
}) {
    const width = 900;
    const height = 600;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    const nf = new Intl.NumberFormat("es-AR");

    // Fondo
    ctx.fillStyle = "#0b1220";
    ctx.fillRect(0, 0, width, height);

    // Barra superior
    const status = drawStatusBarTop(ctx, width, monitoreo, metricas, satProcesosInfo);
    const topOffset = status.barH || 62;

    // Card principal
    const cardX = 40;
    const cardY = topOffset + 20;
    const cardW = width - 80;
    const cardH = height - cardY - 40;

    ctx.fillStyle = "#101a30";
    ctx.fillRect(cardX, cardY, cardW, cardH);

    const year = String(fecha).slice(0, 4);
    const monthName = monthNameEsFromFecha(fecha);

    // Separador superior
    ctx.fillStyle = "#1f2a44";
    ctx.fillRect(cardX + 40, cardY + 45, cardW - 80, 2);

    // Card con número centrado + label abajo izquierda
    function drawStatCard({ x, y, w, h, label, valueText }) {
        ctx.save();
        ctx.shadowColor = "rgba(0, 0, 0, 0.22)";
        ctx.shadowBlur = 10;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 3;

        // casi mismo color que el fondo, apenas distinto
        ctx.fillStyle = "#111b2e";
        ctx.fillRect(x, y, w, h);
        ctx.restore();

        // número
        const fontPx = fitFontPxForText(
            ctx,
            valueText,
            w - 40,
            60,
            24,
            "DejaVuSans",
            "bold"
        );

        ctx.font = `bold ${fontPx}px "DejaVuSans"`;
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(valueText, x + w / 2, y + h / 2 - 8);

        // label abajo izquierda
        ctx.font = 'bold 20px "DejaVuSans"';
        ctx.fillStyle = "#e2e8f0";
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
        ctx.fillText(label, x + 16, y + h - 14);

        // reset
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
    }

    // valores seguros
    const anioSafe = Number.isFinite(Number(anioCantidad)) ? Number(anioCantidad) : 0;
    const hoySafe = Number.isFinite(Number(cantidadDia)) ? Number(cantidadDia) : 0;
    const mesSafe = Number.isFinite(Number(cantidadMes)) ? Number(cantidadMes) : 0;

    const anioFmt = nf.format(anioSafe);
    const hoyFmt = nf.format(hoySafe);
    const mesFmt = nf.format(mesSafe);

    // === CARD SUPERIOR ===
    const topBoxW = 330;
    const topBoxH = 110;
    const topBoxX = cardX + (cardW - topBoxW) / 2;
    const topBoxY = cardY + 85;

    drawStatCard({
        x: topBoxX,
        y: topBoxY,
        w: topBoxW,
        h: topBoxH,
        label: year,
        valueText: anioFmt,
    });

    // === CARDS INFERIORES ===
    const bottomBoxW = 240;
    const bottomBoxH = 100;
    const bottomY = topBoxY + topBoxH + 70;

    const leftX = cardX + 42;
    const rightX = cardX + cardW - 42 - bottomBoxW;

    drawStatCard({
        x: leftX,
        y: bottomY,
        w: bottomBoxW,
        h: bottomBoxH,
        label: "Hoy",
        valueText: hoyFmt,
    });

    drawStatCard({
        x: rightX,
        y: bottomY,
        w: bottomBoxW,
        h: bottomBoxH,
        label: monthName,
        valueText: mesFmt,
    });

    // Separador antes de métricas
    const metricsY = bottomY + bottomBoxH + 22;
    ctx.fillStyle = "#1f2a44";
    ctx.fillRect(cardX + 40, metricsY - 18, cardW - 80, 2);

    // === MÉTRICAS ===
    const cpu = metricas?.usoCpu;
    const ram = metricas?.usoRam;
    const disk = metricas?.usoDisco;
    const lat = metricas?.latenciaMs;
    const load = metricas?.carga1m;
    const ramProc = metricas?.ramProcesoMb;
    const cpuProc = metricas?.cpuProceso;
    const temp = metricas?.temperaturaCpu;

    const parts = [];
    parts.push({ text: `CPU ${fmtPct(cpu)}`, color: metricColorByPct(cpu) });
    parts.push({ text: `RAM ${fmtPct(ram)}`, color: metricColorByPct(ram) });
    parts.push({ text: `DISCO ${fmtPct(disk)}`, color: metricColorByPct(disk) });

    if (lat !== null && lat !== undefined) parts.push({ text: `LAT ${Math.round(lat)}ms`, color: "#cbd5e1" });
    if (load !== null && load !== undefined) parts.push({ text: `LOAD ${Number(load).toFixed(2)}`, color: "#cbd5e1" });
    if (ramProc !== null && ramProc !== undefined) parts.push({ text: `RAMP ${Number(ramProc).toFixed(0)}MB`, color: "#cbd5e1" });
    if (cpuProc !== null && cpuProc !== undefined) parts.push({ text: `CPUP ${Number(cpuProc).toFixed(1)}%`, color: "#cbd5e1" });
    if (temp !== null && temp !== undefined && Number(temp) > 0) parts.push({ text: `TEMP ${Number(temp).toFixed(0)}°`, color: "#cbd5e1" });

    function drawCenteredPartsLine(lineParts, y, fontPx) {
        ctx.font = `bold ${fontPx}px "DejaVuSans"`;
        const sep = "  •  ";
        const sepW = ctx.measureText(sep).width;
        const rendered = lineParts.map((p) => ({ ...p, w: ctx.measureText(p.text).width }));
        const totalW = rendered.reduce((a, r) => a + r.w, 0) + sepW * Math.max(rendered.length - 1, 0);
        let x = cardX + cardW / 2 - totalW / 2;

        for (let i = 0; i < rendered.length; i++) {
            ctx.fillStyle = rendered[i].color;
            ctx.fillText(rendered[i].text, x, y);
            x += rendered[i].w;
            if (i < rendered.length - 1) {
                ctx.fillStyle = "#64748b";
                ctx.fillText(sep, x, y);
                x += sepW;
            }
        }
    }

    const lineY = metricsY + 25;
    drawCenteredPartsLine(parts, lineY, parts.length > 6 ? 16 : 18);

    const satParts = satProcesosInfo?.top?.length
        ? satProcesosInfo.top.map((x) => ({
            text: `SAT ${x.servidor} ${x.reason}`,
            color: satSeverityColor(x.sev),
        }))
        : [{ text: "SAT OK", color: "#22c55e" }];

    drawCenteredPartsLine(satParts, lineY + 34, satParts.length > 2 ? 14 : 16);

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
        const { fecha, mes, cantidadDia, cantidadMes, anioCantidad, monitoreo } =
            await obtenerCantidad(dia);

        const metricas = await obtenerMetricasConjunto();
        const satProcesosInfo = await obtenerSatProcesosInfoSafe();

        const registros = monitoreo?.data ?? [];
        const { maxStreak, afectados } = computeConsecutiveFails(registros);

        const cpu = toNum(metricas?.usoCpu);
        const ram = toNum(metricas?.usoRam);
        const disk = toNum(metricas?.usoDisco);
        const vals = [cpu, ram, disk].filter((v) => v !== null);
        const pctMax = vals.length ? Math.max(...vals) : null;

        const metricSev = severityFromMetricMax(pctMax);
        const microsSev = severityFromMaxStreak(maxStreak);
        const sev = pickWorstSeverity(pickWorstSeverity(metricSev, microsSev), satProcesosInfo.sev);
        console.log("METRICAS RAW:", metricas?._raw);
        console.log("METRICAS PARSED:", { cpu: metricas.usoCpu, ram: metricas.usoRam, disco: metricas.usoDisco });
        console.log("SAT PROCESOS:", satProcesosInfo.summaryText);
        // ✅ Hash: "de a miles" + severidad + afectados
        const logicalPayload = {
            fecha: String(fecha),
            mes: String(mes),

            hoyBucket: bucket1000(cantidadDia),
            mesBucket: bucket1000(cantidadMes),
            anioBucket: bucket1000(anioCantidad),

            sev,
            maxStreak,
            afectados: afectados.map((x) => ({ micro: x.micro, streak: x.streak })),

            metricas: {
                usoCpu: cpu,
                usoRam: ram,
                usoDisco: disk,
                pctMax,
            },
            sat: {
                sev: satProcesosInfo.sev,
                affectedCount: satProcesosInfo.affectedCount,
                top: satProcesosInfo.top.map((x) => ({
                    servidor: x.servidor,
                    sev: x.sev,
                    reason: x.reason,
                    procesosBucket: Number(x.procesos ?? 0),
                    maxSegBucket: x.maxSegundos === null ? null : Math.floor(Number(x.maxSegundos)),
                })),
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
            anioCantidad,   // ✅ ahora sí
            monitoreo,
            metricas,
            satProcesosInfo,
        });

        const safeFecha = String(fecha).replace(/[^0-9a-zA-Z_-]/g, "-");
        const nombreSAT = (nombre && String(nombre)) || `resumen_${safeFecha}_${Date.now()}.png`;

        const imageUrl = await subirImagenSAT({ bufferPng, nombre: nombreSAT });
        const hoyMovimiento = cantidadDia;

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
                satSev: String(satProcesosInfo.sev ?? "verde"),
                satResumen: String(satProcesosInfo.summaryText ?? "SAT OK"),
                satAfectados: JSON.stringify(satProcesosInfo.affected ?? []),

                ...(titulo ? { titulo: String(titulo) } : {}),
                ...(cuerpo ? { cuerpo: String(cuerpo) } : {}),
            },
            android: {
                notification: {
                    imageUrl,
                    channelId: "silent_high",
                },
                priority: "HIGH",
            },
        };

        let fcmResponse;
        try {
            fcmResponse = await admin.messaging().send(message);
        } catch (error) {
            if (isInvalidFcmTokenError(error)) {
                eliminarDispositivoPorToken(token);
            }
            throw error;
        }
        await setLastHash(token, currentHash);

        return res.json({
            ok: true,
            fecha,
            mes,
            cantidadDia,
            cantidadMes,
            anioCantidad,
            imageUrl,
            status,
            metricas,
            satProcesosInfo,
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
    const { fecha, mes, cantidadDia, cantidadMes, monitoreo, anioCantidad } =
        await obtenerCantidad(dia);

    const metricas = await obtenerMetricasConjunto();
    const satProcesosInfo = await obtenerSatProcesosInfoSafe();
    console.log("METRICAS RAW (cron):", metricas?._raw);
    console.log("METRICAS PARSED (cron):", {
        cpu: metricas?.usoCpu,
        ram: metricas?.usoRam,
        disco: metricas?.usoDisco,
    });
    console.log("SAT PROCESOS (cron):", satProcesosInfo.summaryText);


    const registros = monitoreo?.data ?? [];
    const { maxStreak, afectados } = computeConsecutiveFails(registros);

    const cpu = toNum(metricas?.usoCpu);
    const ram = toNum(metricas?.usoRam);
    const disk = toNum(metricas?.usoDisco);
    const vals = [cpu, ram, disk].filter((v) => v !== null);
    const pctMax = vals.length ? Math.max(...vals) : null;

    const metricSev = severityFromMetricMax(pctMax);
    const microsSev = severityFromMaxStreak(maxStreak);
    const sev = pickWorstSeverity(pickWorstSeverity(metricSev, microsSev), satProcesosInfo.sev);

    const logicalPayload = {
        fecha: String(fecha),
        mes: String(mes),

        hoyBucket: bucket1000(cantidadDia),
        mesBucket: bucket1000(cantidadMes),
        anioCantidad: bucket1000(anioCantidad),

        sev,
        maxStreak,
        afectados: afectados.map((x) => ({ micro: x.micro, streak: x.streak })),

        metricas: {
            usoCpu: cpu,
            usoRam: ram,
            usoDisco: disk,
            pctMax,
        },
        sat: {
            sev: satProcesosInfo.sev,
            affectedCount: satProcesosInfo.affectedCount,
            top: satProcesosInfo.top.map((x) => ({
                servidor: x.servidor,
                sev: x.sev,
                reason: x.reason,
                procesosBucket: Number(x.procesos ?? 0),
                maxSegBucket: x.maxSegundos === null ? null : Math.floor(Number(x.maxSegundos)),
            })),
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
        anioCantidad,
        monitoreo,
        metricas,
        satProcesosInfo,
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
            anioCantidad: String(anioCantidad),

            sev: String(status?.sev ?? "verde"),
            maxStreak: String(status?.maxStreak ?? 0),
            afectados: JSON.stringify(status?.afectados ?? []),

            usoCpu: String(cpu ?? ""),
            usoRam: String(ram ?? ""),
            usoDisco: String(disk ?? ""),
            pctMax: String(pctMax ?? ""),
            satSev: String(satProcesosInfo.sev ?? "verde"),
            satResumen: String(satProcesosInfo.summaryText ?? "SAT OK"),
            satAfectados: JSON.stringify(satProcesosInfo.affected ?? []),
        },
        android: {
            notification: {
                channelId: "silent_high",
            },
            priority: "HIGH",
        },
    };

    let resp;
    try {
        resp = await admin.messaging().send(message);
    } catch (error) {
        if (isInvalidFcmTokenError(error)) {
            eliminarDispositivoPorToken(token);
        }
        throw error;
    }
    await setLastHash(token, currentHash);

    return { ok: true, resp, imageUrl, logicalPayload };
}   
