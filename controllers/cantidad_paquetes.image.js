import axios from "axios";
import { createCanvas, registerFont } from "canvas";
import path from "path";
import { fileURLToPath } from "url";
import {
    buildStatusSummary,
    satSeverityColor,
    severityStyle,
} from "./cantidad_paquetes.analysis.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FONT_PATH = path.join(__dirname, "../assets/fonts/DejaVuSans.ttf");

try {
    registerFont(FONT_PATH, { family: "DejaVuSans" });
    console.log("Fuente registrada:", FONT_PATH);
} catch (e) {
    console.error("No se pudo registrar la fuente:", e?.message || e);
}

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
    if (!Number.isFinite(v)) return "#94a3b8";
    if (v >= 80) return "#dc2626";
    if (v >= 70) return "#f97316";
    if (v >= 50) return "#facc15";
    return "#cbd5e1";
}

function cpuColorByPct(pct) {
    const v = Number(pct);
    if (!Number.isFinite(v)) return "#94a3b8";
    if (v >= 95) return "#dc2626";
    if (v >= 90) return "#f97316";
    if (v >= 50) return "#facc15";
    return "#cbd5e1";
}

function diskColorByPct(pct) {
    const v = Number(pct);
    if (!Number.isFinite(v)) return "#94a3b8";
    if (v >= 95) return "#dc2626";
    if (v >= 90) return "#f97316";
    if (v >= 50) return "#facc15";
    return "#cbd5e1";
}

function fitFontPxForText(ctx, text, maxWidth, startPx, minPx, fontFamily, weight = "bold") {
    let px = startPx;
    while (px > minPx) {
        ctx.font = `${weight} ${px}px "${fontFamily}"`;
        if (ctx.measureText(text).width <= maxWidth) return px;
        px -= 2;
    }
    return minPx;
}

function formatDatabaseSummaryText(summaryText) {
    const text = String(summaryText || "").trim();
    if (!text) return "OK";
    return text.replace(/^PROCESOS DB\s*/i, "").trim() || "OK";
}

function drawStatusBarTop(ctx, width, monitoreo, metricas, satProcesosInfo) {
    const status = buildStatusSummary({ monitoreo, metricas, satProcesosInfo });
    const style = severityStyle(status.sev);

    const pairs = [
        { k: "CPU", v: status.cpu },
        { k: "RAM", v: status.ram },
        { k: "DISCO", v: status.disk },
    ].filter((p) => p.v !== null);

    pairs.sort((a, b) => (b.v ?? -1) - (a.v ?? -1));
    const pctMaxName = pairs[0]?.k ?? null;
    const barH = 62;

    ctx.fillStyle = style.bg;
    ctx.fillRect(0, 0, width, barH);

    ctx.fillStyle = style.fg;
    ctx.font = 'bold 22px "DejaVuSans"';
    ctx.fillText(status.sev === "verde" ? "TODO OK" : style.label, 22, 40);

    const parts = [];
    if (pctMaxName && status.pctMax !== null) {
        parts.push(`${pctMaxName} ${Math.round(status.pctMax)}%`);
    }
    if (status.microsSev !== "verde" && status.maxStreak > 0 && status.afectados.length) {
        parts.push(
            status.afectados
                .slice(0, 6)
                .map((x) => `${x.micro}(${x.streak})`)
                .join(", ")
        );
    }
    if (status.satSev !== "verde" && satProcesosInfo?.affectedCount) {
        parts.push(`BASE DE DATOS ${formatDatabaseSummaryText(satProcesosInfo.summaryText)}`);
    }

    if (parts.length) {
        ctx.font = '18px "DejaVuSans"';
        ctx.fillText(parts.join(" | "), 180, 40);
    }

    return { ...status, barH };
}

export function generarImagenResumenBuffer({
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

    ctx.fillStyle = "#0b1220";
    ctx.fillRect(0, 0, width, height);

    const status = drawStatusBarTop(ctx, width, monitoreo, metricas, satProcesosInfo);
    const cardX = 40;
    const cardY = status.barH + 20;
    const cardW = width - 80;
    const cardH = height - cardY - 40;

    ctx.fillStyle = "#101a30";
    ctx.fillRect(cardX, cardY, cardW, cardH);

    const year = String(fecha).slice(0, 4);
    const monthName = monthNameEsFromFecha(fecha);

    ctx.fillStyle = "#1f2a44";
    ctx.fillRect(cardX + 40, cardY + 45, cardW - 80, 2);

    function drawStatCard({ x, y, w, h, label, valueText }) {
        ctx.save();
        ctx.shadowColor = "rgba(0, 0, 0, 0.22)";
        ctx.shadowBlur = 10;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 3;
        ctx.fillStyle = "#111b2e";
        ctx.fillRect(x, y, w, h);
        ctx.restore();

        const fontPx = fitFontPxForText(ctx, valueText, w - 40, 60, 24, "DejaVuSans");
        ctx.font = `bold ${fontPx}px "DejaVuSans"`;
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(valueText, x + w / 2, y + h / 2 - 8);

        ctx.font = 'bold 20px "DejaVuSans"';
        ctx.fillStyle = "#e2e8f0";
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
        ctx.fillText(label, x + 16, y + h - 14);
    }

    const anioFmt = nf.format(Number.isFinite(Number(anioCantidad)) ? Number(anioCantidad) : 0);
    const hoyFmt = nf.format(Number.isFinite(Number(cantidadDia)) ? Number(cantidadDia) : 0);
    const mesFmt = nf.format(Number.isFinite(Number(cantidadMes)) ? Number(cantidadMes) : 0);

    const topBoxW = 330;
    const topBoxH = 110;
    const topBoxX = cardX + (cardW - topBoxW) / 2;
    const topBoxY = cardY + 85;

    drawStatCard({ x: topBoxX, y: topBoxY, w: topBoxW, h: topBoxH, label: year, valueText: anioFmt });

    const bottomBoxW = 240;
    const bottomBoxH = 100;
    const bottomY = topBoxY + topBoxH + 70;
    const leftX = cardX + 42;
    const rightX = cardX + cardW - 42 - bottomBoxW;

    drawStatCard({ x: leftX, y: bottomY, w: bottomBoxW, h: bottomBoxH, label: "Hoy", valueText: hoyFmt });
    drawStatCard({
        x: rightX,
        y: bottomY,
        w: bottomBoxW,
        h: bottomBoxH,
        label: monthName,
        valueText: mesFmt,
    });

    const metricsY = bottomY + bottomBoxH + 22;
    ctx.fillStyle = "#1f2a44";
    ctx.fillRect(cardX + 40, metricsY - 18, cardW - 80, 2);

    const parts = [
        { text: `CPU ${fmtPct(metricas?.usoCpu)}`, color: cpuColorByPct(metricas?.usoCpu) },
        { text: `RAM ${fmtPct(metricas?.usoRam)}`, color: metricColorByPct(metricas?.usoRam) },
        { text: `DISCO ${fmtPct(metricas?.usoDisco)}`, color: diskColorByPct(metricas?.usoDisco) },
    ];

    if (metricas?.latenciaMs !== null && metricas?.latenciaMs !== undefined) {
        parts.push({ text: `LAT ${Math.round(metricas.latenciaMs)}ms`, color: "#cbd5e1" });
    }
    if (metricas?.carga1m !== null && metricas?.carga1m !== undefined) {
        parts.push({ text: `LOAD ${Number(metricas.carga1m).toFixed(2)}`, color: "#cbd5e1" });
    }
    if (metricas?.ramProcesoMb !== null && metricas?.ramProcesoMb !== undefined) {
        parts.push({ text: `RAMP ${Number(metricas.ramProcesoMb).toFixed(0)}MB`, color: "#cbd5e1" });
    }
    if (metricas?.cpuProceso !== null && metricas?.cpuProceso !== undefined) {
        parts.push({ text: `CPUP ${Number(metricas.cpuProceso).toFixed(1)}%`, color: "#cbd5e1" });
    }
    if (
        metricas?.temperaturaCpu !== null &&
        metricas?.temperaturaCpu !== undefined &&
        Number(metricas.temperaturaCpu) > 0
    ) {
        parts.push({ text: `TEMP ${Number(metricas.temperaturaCpu).toFixed(0)}C`, color: "#cbd5e1" });
    }

    function drawCenteredPartsLine(lineParts, y, fontPx) {
        ctx.font = `bold ${fontPx}px "DejaVuSans"`;
        const sep = "  •  ";
        const sepW = ctx.measureText(sep).width;
        const rendered = lineParts.map((p) => ({ ...p, w: ctx.measureText(p.text).width }));
        const totalW =
            rendered.reduce((a, r) => a + r.w, 0) + sepW * Math.max(rendered.length - 1, 0);
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

    const databaseParts =
        status.satSev !== "verde" && satProcesosInfo?.top?.length
        ? satProcesosInfo.top.map((x) => ({
              text: `BASE DE DATOS ${x.servidor} ${x.reason}`,
              color: satSeverityColor(x.sev),
          }))
        : [{ text: "BASE DE DATOS OK", color: "#22c55e" }];

    drawCenteredPartsLine(
        databaseParts,
        lineY + 34,
        databaseParts.length > 2 ? 14 : 16
    );

    return { buf: canvas.toBuffer("image/png"), status };
}

export async function subirImagenSAT({ bufferPng, nombre }) {
    const payload = {
        foto: `image/png;base64,${bufferPng.toString("base64")}`,
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
        throw new Error(`SAT no devolvio URL valida: ${url}`);
    }

    return url;
}
