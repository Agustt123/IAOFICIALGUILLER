import { bucket1000, computeConsecutiveFails, toNum } from "./cantidad_paquetes.data.js";

const focusState = new Map();

export function severityRank(s) {
    if (s === "rojo") return 3;
    if (s === "naranja") return 2;
    if (s === "amarillo") return 1;
    return 0;
}

export function pickWorstSeverity(a, b) {
    return severityRank(a) >= severityRank(b) ? a : b;
}

export function severityFromMetricMax(pctMax) {
    const v = Number(pctMax);
    if (!Number.isFinite(v)) return "amarillo";
    if (v >= 95) return "rojo";
    if (v >= 90) return "naranja";
    if (v >= 50) return "amarillo";
    return "verde";
}

export function severityFromDiskPct(pct) {
    const v = Number(pct);
    if (!Number.isFinite(v)) return "amarillo";
    if (v >= 95) return "rojo";
    if (v >= 90) return "naranja";
    if (v >= 50) return "amarillo";
    return "verde";
}

export function severityFromMaxStreak(maxStreak) {
    const s = Number(maxStreak) || 0;
    if (s >= 3) return "rojo";
    if (s === 2) return "naranja";
    if (s === 1) return "amarillo";
    return "verde";
}

export function severityStyle(sev) {
    if (sev === "rojo") return { bg: "#dc2626", fg: "#ffffff", label: "CRITICO" };
    if (sev === "naranja") return { bg: "#f97316", fg: "#111827", label: "ALTO" };
    if (sev === "amarillo") return { bg: "#facc15", fg: "#111827", label: "ATENCION" };
    return { bg: "#22c55e", fg: "#052e16", label: "TODO OK" };
}

export function severityPct(sev) {
    if (sev === "rojo") return 99;
    if (sev === "naranja") return 75;
    if (sev === "amarillo") return 50;
    return 0;
}

function shortSecondsLabel(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return "--";
    if (n >= 10) return `${Math.round(n)}s`;
    return `${n.toFixed(1)}s`;
}

export function satSeverityColor(sev) {
    if (sev === "rojo") return "#dc2626";
    if (sev === "naranja") return "#f97316";
    if (sev === "amarillo") return "#facc15";
    return "#22c55e";
}

function isSatConjuntoRow(row) {
    return String(row?.servidor || "").toLowerCase() === "conjunto";
}

function buildFocusSignature(parts) {
    return parts.filter(Boolean).join("|") || "ok";
}

function gateSeverityAfterThreeHits(focusKey, rawSev, signature) {
    const currentSignature = rawSev === "verde" ? "ok" : String(signature || rawSev);
    const previous = focusState.get(focusKey);

    if (rawSev === "verde") {
        focusState.set(focusKey, { signature: currentSignature, hits: 0, rawSev });
        return { sev: "verde", hits: 0 };
    }

    const hits =
        previous && previous.signature === currentSignature && previous.rawSev === rawSev
            ? previous.hits + 1
            : 1;

    focusState.set(focusKey, { signature: currentSignature, hits, rawSev });

    return {
        sev: hits >= 3 ? rawSev : "verde",
        hits,
    };
}

function severityFromSatRow(row) {
    if (!row.ok || row.error || (row.codigoHttp !== null && row.codigoHttp >= 500)) {
        return "rojo";
    }

    const procesos = Number(row.procesos ?? 0);
    const maxSeg = Number(row.maxSegundos ?? 0);
    const avgSeg = Number(row.promedioSegundos ?? 0);
    const latMs = Number(row.latenciaMs ?? 0);

    if (isSatConjuntoRow(row)) {
        if (maxSeg >= 15) return "rojo";
        if (procesos >= 50) return "rojo";
        if (maxSeg >= 8 || avgSeg >= 5) return "naranja";
        if (procesos >= 40) return "naranja";
        if (maxSeg >= 4 || avgSeg >= 2 || latMs >= 1500) return "amarillo";
        if (procesos >= 30) return "amarillo";
        return "verde";
    }

    if (maxSeg >= 15) return "rojo";
    if (procesos >= 20) return "rojo";
    if (maxSeg >= 8 || avgSeg >= 5) return "naranja";
    if (procesos >= 15) return "naranja";
    if (maxSeg >= 4 || avgSeg >= 2 || latMs >= 1500) return "amarillo";
    if (procesos > 10) return "amarillo";
    return "verde";
}

function isImmediateDbIncident(row) {
    return !row.ok || !!row.error || (row.codigoHttp !== null && row.codigoHttp >= 500);
}

function satReasonForRow(row, sev) {
    if (!row.ok || row.error) return "ERROR";
    if (row.codigoHttp !== null && row.codigoHttp >= 500) return `HTTP ${row.codigoHttp}`;
    if (sev === "rojo" || sev === "naranja") {
        if ((row.maxSegundos ?? 0) > 0) return `MAX ${shortSecondsLabel(row.maxSegundos)}`;
        if ((row.promedioSegundos ?? 0) > 0) return `AVG ${shortSecondsLabel(row.promedioSegundos)}`;
        if (row.procesos > 0) return `PROCESOS ALTOS (${row.procesos})`;
    }
    if (row.procesos >= 5) return `PROCESOS ALTOS (${row.procesos})`;
    if ((row.latenciaMs ?? 0) >= 1500) return `LAT ${Math.round(row.latenciaMs)}ms`;
    if ((row.maxSegundos ?? 0) > 0) return `MAX ${shortSecondsLabel(row.maxSegundos)}`;
    if (isSatConjuntoRow(row) && row.procesos > 0) return `TOTAL ${row.procesos}`;
    return "OK";
}

export function analyzeSatProcesos(rows) {
    const normalized = Array.isArray(rows) ? rows : [];
    const incidents = normalized.map((row) => {
        const sev = severityFromSatRow(row);
        const reason = satReasonForRow(row, sev);
        return {
            servidor: row.servidor,
            sev,
            reason,
            procesos: row.procesos,
            promedioSegundos: row.promedioSegundos,
            maxSegundos: row.maxSegundos,
            latenciaMs: row.latenciaMs,
            ok: row.ok,
            codigoHttp: row.codigoHttp,
            error: row.error,
            immediate: isImmediateDbIncident(row),
            signature: `${row.servidor}|${reason}`,
        };
    });

    const countsBySignature = incidents.reduce((acc, item) => {
        acc.set(item.signature, (acc.get(item.signature) ?? 0) + 1);
        return acc;
    }, new Map());

    incidents.sort(
        (a, b) =>
            severityRank(b.sev) - severityRank(a.sev) ||
            (b.maxSegundos ?? 0) - (a.maxSegundos ?? 0) ||
            (b.procesos ?? 0) - (a.procesos ?? 0) ||
            a.servidor.localeCompare(b.servidor)
    );

    const affected = incidents.filter((x) => {
        if (x.sev === "verde") return false;
        if (x.immediate) return true;
        return (countsBySignature.get(x.signature) ?? 0) >= 3;
    });

    const uniqueAffected = affected.filter(
        (item, index, list) => list.findIndex((x) => x.signature === item.signature) === index
    );
    const sev = uniqueAffected.reduce((acc, x) => pickWorstSeverity(acc, x.sev), "verde");
    const top = (uniqueAffected.length ? uniqueAffected : incidents.slice(0, 3)).slice(0, 3);

    return {
        sev,
        total: normalized.length,
        affectedCount: uniqueAffected.length,
        okCount: incidents.filter((x) => x.ok).length,
        incidents,
        affected: uniqueAffected,
        top,
        summaryText: affected.length
            ? top.map((x) => `${x.servidor} ${x.reason}`).join(" | ")
            : `PROCESOS DB OK ${normalized.length}/${normalized.length}`,
    };
}

export async function obtenerSatProcesosInfoSafe(fetchProcesos) {
    try {
        return analyzeSatProcesos(await fetchProcesos());
    } catch (error) {
        const incident = {
            servidor: "procesosdb",
            sev: "rojo",
            reason: "ERROR",
            procesos: 0,
            promedioSegundos: null,
            maxSegundos: null,
            latenciaMs: null,
            ok: false,
            codigoHttp: null,
            error: String(error?.message || error),
        };

        return {
            sev: "rojo",
            total: 0,
            affectedCount: 1,
            okCount: 0,
            incidents: [],
            affected: [incident],
            top: [incident],
            summaryText: "procesosdb ERROR",
        };
    }
}

export function summarizeMetricas(metricas) {
    const cpu = toNum(metricas?.usoCpu);
    const ram = toNum(metricas?.usoRam);
    const disk = toNum(metricas?.usoDisco);
    const vals = [cpu, ram, disk].filter((v) => v !== null);

    return {
        cpu,
        ram,
        disk,
        pctMax: vals.length ? Math.max(...vals) : null,
    };
}

export function buildStatusSummary({ monitoreo, metricas, satProcesosInfo }) {
    const registros = monitoreo?.data ?? [];
    const { maxStreak, afectados } = computeConsecutiveFails(registros);
    const { cpu, ram, disk, pctMax } = summarizeMetricas(metricas);
    const rawMetricSev = [severityFromMetricMax(cpu), severityFromMetricMax(ram), severityFromDiskPct(disk)]
        .reduce((worst, current) => pickWorstSeverity(worst, current), "verde");
    const rawMicrosSev = severityFromMaxStreak(maxStreak);
    const rawSatSev = satProcesosInfo?.sev ?? "verde";

    const metricFocus = gateSeverityAfterThreeHits(
        "server",
        rawMetricSev,
        buildFocusSignature([
            rawMetricSev,
            cpu === null ? null : `cpu:${Math.round(cpu)}`,
            ram === null ? null : `ram:${Math.round(ram)}`,
            disk === null ? null : `disk:${Math.round(disk)}`,
        ])
    );
    const microsFocus = gateSeverityAfterThreeHits(
        "microservices",
        rawMicrosSev,
        buildFocusSignature([
            rawMicrosSev,
            ...afectados.map((x) => `${x.micro}:${x.streak}`),
        ])
    );
    const dbFocus = gateSeverityAfterThreeHits(
        "database",
        rawSatSev,
        buildFocusSignature([
            rawSatSev,
            ...(satProcesosInfo?.affected ?? []).map((x) => `${x.servidor}:${x.reason}:${x.sev}`),
        ])
    );

    const metricSev = metricFocus.sev;
    const microsSev = microsFocus.sev;
    const satSev = dbFocus.sev;

    return {
        cpu,
        ram,
        disk,
        pctMax,
        maxStreak,
        afectados,
        metricSev,
        microsSev,
        satSev,
        rawMetricSev,
        rawMicrosSev,
        rawSatSev,
        serverAlertHits: metricFocus.hits,
        microservicesAlertHits: microsFocus.hits,
        databaseAlertHits: dbFocus.hits,
        sev: pickWorstSeverity(pickWorstSeverity(metricSev, microsSev), satSev),
    };
}

export function computeWorstPct({ pctMax, maxStreak, satProcesosInfo }) {
    const candidates = [];
    const metricPct = Number(pctMax);

    if (Number.isFinite(metricPct)) {
        candidates.push(Math.max(0, Math.min(99, Math.round(metricPct))));
    }

    const streak = Number(maxStreak) || 0;
    if (streak >= 3) candidates.push(99);
    else if (streak === 2) candidates.push(75);
    else if (streak === 1) candidates.push(50);

    candidates.push(severityPct(satProcesosInfo?.sev));

    return candidates.length ? Math.max(...candidates) : 0;
}

export function buildLogicalPayload({
    fecha,
    mes,
    cantidadDia,
    cantidadMes,
    anioCantidad,
    status,
    satProcesosInfo,
}) {
    return {
        fecha: String(fecha),
        mes: String(mes),
        hoyBucket: bucket1000(cantidadDia),
        mesBucket: bucket1000(cantidadMes),
        anioBucket: bucket1000(anioCantidad),
        sev: status.sev,
        maxStreak: status.maxStreak,
        afectados: status.afectados.map((x) => ({ micro: x.micro, streak: x.streak })),
        metricas: {
            usoCpu: status.cpu,
            usoRam: status.ram,
            usoDisco: status.disk,
            pctMax: status.pctMax,
        },
        sat: {
            sev: satProcesosInfo.sev,
            affectedCount: satProcesosInfo.affectedCount,
            top: satProcesosInfo.top.map((x) => ({
                servidor: x.servidor,
                sev: x.sev,
                reason: x.reason,
                procesosBucket: Number(x.procesos ?? 0),
                maxSegBucket:
                    x.maxSegundos === null ? null : Math.floor(Number(x.maxSegundos)),
            })),
        },
    };
}
