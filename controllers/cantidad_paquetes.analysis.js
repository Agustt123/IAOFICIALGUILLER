import { bucket1000, computeConsecutiveFails, toNum } from "./cantidad_paquetes.data.js";

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
    if (v >= 80) return "rojo";
    if (v >= 70) return "naranja";
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
    if (!row.ok || row.error) return "ERROR";
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

export function analyzeSatProcesos(rows) {
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

    incidents.sort(
        (a, b) =>
            severityRank(b.sev) - severityRank(a.sev) ||
            (b.maxSegundos ?? 0) - (a.maxSegundos ?? 0) ||
            (b.procesos ?? 0) - (a.procesos ?? 0) ||
            a.servidor.localeCompare(b.servidor)
    );

    const affected = incidents.filter((x) => x.sev !== "verde");
    const sev = affected.reduce((acc, x) => pickWorstSeverity(acc, x.sev), "verde");
    const top = (affected.length ? affected : incidents).slice(0, 3);

    return {
        sev,
        total: normalized.length,
        affectedCount: affected.length,
        okCount: incidents.filter((x) => x.ok).length,
        incidents,
        affected,
        top,
        summaryText: affected.length
            ? top.map((x) => `${x.servidor} ${x.reason}`).join(" | ")
            : `SAT OK ${normalized.length}/${normalized.length}`,
    };
}

export async function obtenerSatProcesosInfoSafe(fetchProcesos) {
    try {
        return analyzeSatProcesos(await fetchProcesos());
    } catch (error) {
        const incident = {
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
        };

        return {
            sev: "rojo",
            total: 0,
            affectedCount: 1,
            okCount: 0,
            incidents: [],
            affected: [incident],
            top: [incident],
            summaryText: "sat ERROR",
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
    const metricSev = severityFromMetricMax(pctMax);
    const microsSev = severityFromMaxStreak(maxStreak);
    const satSev = satProcesosInfo?.sev ?? "verde";

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
