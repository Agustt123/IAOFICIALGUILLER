import axios from "axios";
import crypto from "crypto";

const FAIL_MS = 2000;
const lastHashByToken = new Map();

export function isFail(ms) {
    if (ms === null || ms === undefined) return true;
    const n = Number(ms);
    return !Number.isFinite(n) || n > FAIL_MS;
}

export function computeConsecutiveFails(registros) {
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
            else break;
        }
        if (streak > 0) afectados.push({ micro, streak });
    }

    afectados.sort((a, b) => b.streak - a.streak || a.micro.localeCompare(b.micro));

    return {
        maxStreak: afectados[0]?.streak ?? 0,
        afectados,
    };
}

export function stableStringify(obj) {
    const allKeys = [];
    JSON.stringify(obj, (k, v) => (allKeys.push(k), v));
    allKeys.sort();
    return JSON.stringify(obj, allKeys);
}

export function sha256(str) {
    return crypto.createHash("sha256").update(str).digest("hex");
}

export function isInvalidFcmTokenError(error) {
    const code = String(error?.code || "");
    return (
        code === "messaging/registration-token-not-registered" ||
        code === "messaging/invalid-registration-token"
    );
}

export async function getLastHash(token) {
    return lastHashByToken.get(String(token)) ?? null;
}

export async function setLastHash(token, lastHash) {
    lastHashByToken.set(String(token), String(lastHash));
}

export function todayLocalYYYYMMDD() {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Argentina/Buenos_Aires",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(new Date());
}

export function bucket1000(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return null;
    return Math.floor(x / 1000);
}

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

    if (!data?.ok) throw new Error(`Respuesta invalida de /cantidad: ${JSON.stringify(data)}`);
    if (!dataServidores?.estado || !Array.isArray(dataServidores?.data)) {
        throw new Error(`Respuesta invalida de /monitoreo: ${JSON.stringify(dataServidores)}`);
    }

    return {
        fecha: data.fecha ?? diaFinal,
        mes: data.mes ?? String(diaFinal).slice(0, 7),
        cantidadDia: Number(data.hoy ?? data.cantidadDia ?? data.cantidad ?? 0),
        cantidadMes: Number(data.mesCantidad ?? data.cantidadMes ?? 0),
        anioCantidad: Number(data.añoCantidad ?? data.anioCantidad ?? 0),
        mesNombre: data.nombre,
        monitoreo: dataServidores,
    };
}

export function toNum(v) {
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
        throw new Error(`Respuesta invalida de /monitoreo/metricas: ${JSON.stringify(data)}`);
    }

    const rows = data.data.rows;
    const row =
        rows.find(
            (r) =>
                String(r.servidor).toLowerCase() === "conjunto" &&
                String(r.endpoint).toUpperCase() === "ALL"
        ) ||
        rows.find((r) => String(r.servidor).toLowerCase() === "conjunto") ||
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
        throw new Error(
            `Respuesta invalida de /monitoreo/procesos-conjunto: ${JSON.stringify(data)}`
        );
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
