import admin from "firebase-admin";
import axios from "axios";
import { eliminarDispositivoPorToken } from "./device.controller.js";
import {
    guardarAlertaNotificacion,
    guardarDetalleNotificacion,
    guardarSnapshotNotificacion,
} from "../uttils/notificacionSnapshot.store.js";
import {
    getLastHash,
    isInvalidFcmTokenError,
    obtenerCantidad,
    obtenerMetricasConjunto,
    obtenerProcesosConjunto,
    setLastHash,
    sha256,
    stableStringify,
    todayLocalYYYYMMDD,
} from "./cantidad_paquetes.data.js";
import {
    buildLogicalPayload,
    buildStatusSummary,
    computeWorstPct,
    obtenerSatProcesosInfoSafe,
} from "./cantidad_paquetes.analysis.js";
import {
    generarImagenResumenBuffer,
    subirImagenSAT,
} from "./cantidad_paquetes.image.js";

export { obtenerCantidad, obtenerMetricasConjunto, obtenerProcesosConjunto, todayLocalYYYYMMDD };

const ALERTA_LISTA_URL =
    process.env.NOTIFICACION_ALERTA_GET_URL ?? "http://dw.lightdata.app/monitoreo/alerta";
const DETALLE_NOTIFICACION_URL =
    process.env.NOTIFICACION_DETALLE_GET_URL ??
    "http://dw.lightdata.app/monitoreo/notificaciones-ultima";
const PEOR_PCT_LISTA_URL =
    process.env.NOTIFICACION_PEOR_PCT_GET_URL ?? "http://dw.lightdata.app/monitoreo/peor-pct";

function normalizeArray(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
    return [];
}

function firstObject(value) {
    if (Array.isArray(value)) return value[0] ?? null;
    if (value && typeof value === "object") return value;
    return null;
}

function unwrapDataEnvelope(payload) {
    let current = payload;

    for (let i = 0; i < 4; i += 1) {
        if (Array.isArray(current)) return current;
        if (!current || typeof current !== "object") return current;
        if (!("data" in current)) return current;
        current = current.data;
    }

    return current;
}

function formatPct(value) {
    const n = Number(value);
    return Number.isFinite(n) ? `${Math.round(n)}%` : null;
}

function formatDateTimeEs(value) {
    if (!value) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
}

function buildServerFocus(detail) {
    const cpu = detail?.uso_cpu ?? detail?.usoCpu ?? null;
    const ram = detail?.uso_ram ?? detail?.usoRam ?? null;
    const disk = detail?.uso_disco ?? detail?.usoDisco ?? null;
    const pctMax = detail?.pct_max ?? detail?.pctMax ?? null;
    const sev = String(detail?.sev_servidor ?? detail?.serverSev ?? detail?.sev ?? "verde");

    const metrics = [
        cpu !== null && cpu !== undefined ? `CPU ${formatPct(cpu)}` : null,
        ram !== null && ram !== undefined ? `RAM ${formatPct(ram)}` : null,
        disk !== null && disk !== undefined ? `DISCO ${formatPct(disk)}` : null,
    ].filter(Boolean);

    return {
        nombre: "Servidor",
        sev,
        resumen: metrics.length
            ? metrics.join(" | ")
            : pctMax !== null && pctMax !== undefined
                ? `Uso maximo ${formatPct(pctMax)}`
                : "Sin novedades",
        detalle: {
            cpu,
            ram,
            disco: disk,
            pctMax,
        },
    };
}

function buildDatabaseFocus(detail, fallbackAlerta = null) {
    const dbItems = normalizeArray(
        detail?.sat_afectados ??
        detail?.satAfectados ??
        fallbackAlerta?.detalle_alerta?.procesos_db_afectados
    );
    const satResumen =
        detail?.sat_resumen ?? detail?.satResumen ?? fallbackAlerta?.resumen_alerta ?? null;
    const sev = String(detail?.sat_sev ?? detail?.satSev ?? "verde");

    return {
        nombre: "Base de datos",
        sev,
        resumen:
            dbItems.length > 0
                ? dbItems
                    .slice(0, 3)
                    .map((item) => `${item?.servidor || "db"} ${item?.reason || item?.sev || ""}`.trim())
                    .join(" | ")
                : satResumen || "Sin novedades",
        detalle: {
            afectados: dbItems,
        },
    };
}

function buildMicroservicesFocus(detail, fallbackAlerta = null) {
    const micros = normalizeArray(detail?.afectados ?? fallbackAlerta?.detalle_alerta?.afectados);
    const sev = String(detail?.sev_microservicios ?? detail?.microservicesSev ?? (micros.length > 0 ? detail?.sev : "verde") ?? "verde");

    return {
        nombre: "Microservicios",
        sev,
        resumen:
            micros.length > 0
                ? micros
                    .slice(0, 4)
                    .map((item) => `${item?.micro || "micro"} (${item?.streak || 0})`)
                    .join(" | ")
                : "Sin novedades",
        detalle: {
            afectados: micros,
            maxStreak: detail?.max_streak ?? detail?.maxStreak ?? 0,
        },
    };
}

function buildEstadoActual(detalle = {}, fallbackAlerta = null) {
    const server = buildServerFocus(detalle);
    const database = buildDatabaseFocus(detalle, fallbackAlerta);
    const microservices = buildMicroservicesFocus(detalle, fallbackAlerta);
    const focos = [server, database, microservices];
    const focosActivos = focos.filter((x) => x.sev !== "verde");

    return {
        id: detalle?.id ?? detalle?.did ?? null,
        fecha: detalle?.autofecha ?? null,
        token: detalle?.token ?? null,
        imageUrl: detalle?.image_url ?? detalle?.imageUrl ?? null,
        sev: String(detalle?.sev ?? "verde"),
        satSev: String(detalle?.sat_sev ?? detalle?.satSev ?? "verde"),
        porcentajeError: detalle?.pct_max ?? detalle?.pctMax ?? null,
        hayAlertaActiva: String(detalle?.sev ?? "verde") !== "verde",
        focosActivos: focosActivos.map((x) => x.nombre),
        cantidadFocosActivos: focosActivos.length,
        focos: {
            servidor: server,
            baseDeDatos: database,
            microservicios: microservices,
        },
    };
}

function buildUltimaAlerta(alerta = {}) {
    const detalle = alerta?.detalle_alerta ?? {};
    return {
        id: alerta?.id ?? alerta?.did ?? null,
        didNotificaciones: alerta?.did_notificaciones ?? alerta?.didNotificaciones ?? null,
        titulo: alerta?.titulo ?? "Alerta de monitoreo",
        sev: String(alerta?.sev ?? "verde"),
        color: alerta?.color ?? alerta?.sev ?? "rojo",
        porcentajeError: alerta?.porcentaje_error ?? alerta?.porcentajeError ?? null,
        resumen: alerta?.resumen_alerta ?? alerta?.resumenAlerta ?? "Sin novedades",
        queFallo: alerta?.que_fallo ?? alerta?.queFallo ?? null,
        imageUrl: alerta?.image_url ?? alerta?.imageUrl ?? null,
        token: alerta?.token ?? null,
        fecha: alerta?.autofecha ?? null,
        detalle: {
            cosasFallando: normalizeArray(detalle?.cosas_fallando),
            microservicios: normalizeArray(detalle?.afectados),
            baseDeDatos: normalizeArray(detalle?.procesos_db_afectados),
        },
    };
}

function buildAlertaTextoCorto(alerta = {}) {
    const detalle = alerta?.detalle ?? {};
    const db = normalizeArray(detalle?.baseDeDatos);
    const micros = normalizeArray(detalle?.microservicios);
    const cosas = normalizeArray(detalle?.cosasFallando);

    let focoPrincipal = "Sistema";
    let resumen = "Se detectaron problemas de monitoreo.";
    let queFallo = alerta?.queFallo || alerta?.resumen || "Se detecto un problema.";

    const detalleSimple = {
        servidor: "OK",
        microservicios: "OK",
        baseDeDatos: "OK",
    };

    if (db.length > 0) {
        focoPrincipal = "Base de datos";
        const item = db[0];
        const servidor = item?.servidor || "produccion";
        const reason = item?.reason || item?.sev || "ERROR";
        resumen = "Se detectaron problemas en base de datos.";
        queFallo = `Servidor ${servidor} con ${reason.toLowerCase()} en procesos DB.`;
        detalleSimple.baseDeDatos = `${servidor} ${reason}`;
    }

    if (micros.length > 0) {
        const microsText = micros
            .slice(0, 2)
            .map((item) => `${item?.micro || "micro"} (${item?.streak || 0})`)
            .join(" | ");
        if (focoPrincipal === "Sistema") {
            focoPrincipal = "Microservicios";
            resumen = "Se detectaron problemas en microservicios.";
            queFallo = `Microservicios con fallas consecutivas: ${microsText}.`;
        }
        detalleSimple.microservicios = microsText;
    }

    if (focoPrincipal === "Sistema" && cosas.length > 0) {
        resumen = "Se detectaron problemas de monitoreo.";
        queFallo = String(cosas[0]);
    }

    return {
        fecha: formatDateTimeEs(alerta?.fecha),
        estado: "ALERTA",
        color: alerta?.color || "rojo",
        focoPrincipal,
        resumen,
        queFallo,
        detalle: detalleSimple,
    };
}

function buildAlertaResumenV2({ alerta, detalle }) {
    const estadoActual = buildEstadoActual(detalle ?? {}, alerta ?? null);
    const ultimaAlerta = alerta && Object.keys(alerta).length ? buildUltimaAlerta(alerta) : null;
    const alertaResumen = ultimaAlerta ? buildAlertaTextoCorto(ultimaAlerta) : null;

    return {
        alertaActiva: Boolean(estadoActual.hayAlertaActiva),
        ultimaAlerta: alertaResumen,
    };
}

function buildPeorPctItemV2(item) {
    return {
        fecha: item?.autofecha ?? item?.fecha ?? null,
        peorPct: Number(item?.peor_pct ?? item?.peorPct ?? 0),
        cantidadDia: Number(item?.cantidad_dia ?? item?.cantidadDia ?? 0),
        tiempoImagenMs: Number(item?.tiempo_imagen_ms ?? item?.tiempoImagenMs ?? 0),
    };
}

function parseLimit(rawLimit, defaultValue = 1) {
    const value = Number(rawLimit);
    if (!Number.isFinite(value)) return defaultValue;
    return Math.max(1, Math.min(100, Math.trunc(value)));
}

function matchDetalleParaAlerta(alerta, detalle) {
    if (!alerta || !detalle) return {};

    const alertaDid = Number(alerta?.did_notificaciones ?? alerta?.didNotificaciones ?? 0);
    const detalleId = Number(detalle?.id ?? detalle?.did ?? detalle?.did_notificaciones ?? 0);

    if (!alertaDid || !detalleId) return {};
    return alertaDid === detalleId ? detalle : {};
}

async function obtenerAlertasGuardadas(limit = 1) {
    const { data } = await axios.get(ALERTA_LISTA_URL, {
        timeout: 15000,
        params: { limit },
    });

    const unwrapped = unwrapDataEnvelope(data);
    return Array.isArray(unwrapped) ? unwrapped : firstObject(unwrapped) ? [firstObject(unwrapped)] : [];
}

async function obtenerPeorPctGuardado(limit = 30) {
    const { data } = await axios.get(PEOR_PCT_LISTA_URL, {
        timeout: 15000,
        params: { limit },
    });

    const unwrapped = unwrapDataEnvelope(data);
    return Array.isArray(unwrapped) ? unwrapped : firstObject(unwrapped) ? [firstObject(unwrapped)] : [];
}

async function obtenerUltimoDetalleGuardado() {
    const { data } = await axios.get(DETALLE_NOTIFICACION_URL, {
        timeout: 15000,
    });

    const unwrapped = unwrapDataEnvelope(data);
    return firstObject(unwrapped);
}

async function cargarResumenBase(dia) {
    const cantidad = await obtenerCantidad(dia);
    const metricas = await obtenerMetricasConjunto();
    const satProcesosInfo = await obtenerSatProcesosInfoSafe(obtenerProcesosConjunto);
    const status = buildStatusSummary({
        monitoreo: cantidad.monitoreo,
        metricas,
        satProcesosInfo,
    });
    const logicalPayload = buildLogicalPayload({
        ...cantidad,
        status,
        satProcesosInfo,
    });
    const peorPct = computeWorstPct({
        pctMax: status.pctMax,
        maxStreak: status.maxStreak,
        satProcesosInfo,
    });

    return {
        ...cantidad,
        metricas,
        satProcesosInfo,
        status,
        logicalPayload,
        peorPct,
    };
}

function logResumen(prefix, metricas, satProcesosInfo) {
    const label = prefix ? `${prefix} ` : "";
    console.log(`${label}METRICAS RAW:`, metricas?._raw);
    console.log(`${label}METRICAS PARSED:`, {
        cpu: metricas?.usoCpu,
        ram: metricas?.usoRam,
        disco: metricas?.usoDisco,
    });
    console.log(`${label}PROCESOS DB:`, satProcesosInfo?.summaryText);
}

async function generarImagenYSubir({
    fecha,
    cantidadDia,
    cantidadMes,
    anioCantidad,
    monitoreo,
    metricas,
    satProcesosInfo,
    nombre,
}) {
    const imageStart = Date.now();
    const { buf: bufferPng, status } = generarImagenResumenBuffer({
        fecha,
        cantidadDia,
        cantidadMes,
        anioCantidad,
        monitoreo,
        metricas,
        satProcesosInfo,
    });
    const tiempoImagenMs = Date.now() - imageStart;

    const safeFecha = String(fecha).replace(/[^0-9a-zA-Z_-]/g, "-");
    const nombreSAT = (nombre && String(nombre)) || `resumen_${safeFecha}_${Date.now()}.png`;
    const imageUrl = await subirImagenSAT({ bufferPng, nombre: nombreSAT });

    return { imageUrl, tiempoImagenMs, status };
}

function buildMessageData({
    fecha,
    mes,
    cantidadDia,
    cantidadMes,
    anioCantidad,
    status,
    satProcesosInfo,
    imageUrl,
    titulo,
    cuerpo,
}) {
    return {
        imageUrl,
        fecha: String(fecha),
        mes: String(mes),
        cantidadDia: String(cantidadDia),
        cantidadMes: String(cantidadMes),
        anioCantidad: String(anioCantidad),
        hoyMovimiento: String(cantidadDia),
        sev: String(status?.sev ?? "verde"),
        maxStreak: String(status?.maxStreak ?? 0),
        afectados: JSON.stringify(status?.afectados ?? []),
        usoCpu: String(status?.cpu ?? ""),
        usoRam: String(status?.ram ?? ""),
        usoDisco: String(status?.disk ?? ""),
        pctMax: String(status?.pctMax ?? ""),
        satSev: String(satProcesosInfo?.sev ?? "verde"),
        satResumen: String(satProcesosInfo?.summaryText ?? "PROCESOS DB OK"),
        satAfectados: JSON.stringify(satProcesosInfo?.affected ?? []),
        ...(titulo ? { titulo: String(titulo) } : {}),
        ...(cuerpo ? { cuerpo: String(cuerpo) } : {}),
    };
}

function buildPushMessage({
    token,
    fecha,
    mes,
    cantidadDia,
    cantidadMes,
    anioCantidad,
    status,
    satProcesosInfo,
    imageUrl,
    titulo,
    cuerpo,
}) {
    return {
        token,
        data: buildMessageData({
            fecha,
            mes,
            cantidadDia,
            cantidadMes,
            anioCantidad,
            status,
            satProcesosInfo,
            imageUrl,
            titulo,
            cuerpo,
        }),
        android: {
            // Correcto por ahora: no agregar `notification` dentro de `android`.
            // La app mobile toma estos datos desde `data`.
            priority: "HIGH",
        },
    };
}

function buildCronMessage({
    token,
    fecha,
    mes,
    cantidadDia,
    cantidadMes,
    anioCantidad,
    status,
    satProcesosInfo,
    imageUrl,
}) {
    return {
        token,
        data: {
            channelId: "silent_high",
            ...buildMessageData({
                fecha,
                mes,
                cantidadDia,
                cantidadMes,
                anioCantidad,
                status,
                satProcesosInfo,
                imageUrl,
            }),
        },
        android: {
            priority: "HIGH",
        },
    };
}

async function enviarMensajeFcm(message) {
    try {
        return await admin.messaging().send(message);
    } catch (error) {
        if (isInvalidFcmTokenError(error)) {
            eliminarDispositivoPorToken(message.token);
        }
        throw error;
    }
}

async function guardarMetricasEnvio({
    token,
    imageUrl,
    fecha,
    mes,
    cantidadDia,
    cantidadMes,
    anioCantidad,
    status,
    satProcesosInfo,
    peorPct,
    tiempoImagenMs,
}) {
    let didNotificaciones = 0;

    try {
        await guardarSnapshotNotificacion({
            cantidadDia,
            peorPct,
            tiempoImagenMs,
        });
    } catch (snapshotError) {
        console.error(
            "No se pudo guardar snapshot de notificacion:",
            snapshotError?.message || snapshotError
        );
    }

    try {
        const detalleResponse = await guardarDetalleNotificacion({
            token,
            imageUrl,
            fecha,
            mes,
            cantidadDia,
            cantidadMes,
            anioCantidad,
            hoyMovimiento: cantidadDia,
            sev: status?.sev ?? "verde",
            maxStreak: status?.maxStreak ?? 0,
            afectados: status?.afectados ?? [],
            usoCpu: status?.cpu,
            usoRam: status?.ram,
            usoDisco: status?.disk,
            pctMax: status?.pctMax,
            satSev: satProcesosInfo?.sev ?? "verde",
            satResumen: satProcesosInfo?.summaryText ?? "PROCESOS DB OK",
            satAfectados: satProcesosInfo?.affected ?? [],
            peorPct,
            tiempoImagenMs,
        });
        didNotificaciones = Number(detalleResponse?.id || detalleResponse?.data?.id || 0);
        console.log(
            `Notificacion detalle guardada. did_notificaciones=${didNotificaciones} sev=${status?.sev ?? "verde"
            }`
        );
    } catch (detalleError) {
        console.error(
            "No se pudo guardar detalle de notificacion:",
            detalleError?.message || detalleError
        );
    }

    if ((status?.sev ?? "verde") === "verde" || didNotificaciones <= 0) {
        console.log(
            `Alerta omitida. sev=${status?.sev ?? "verde"} did_notificaciones=${didNotificaciones}`
        );
        return { didNotificaciones };
    }

    try {
        const alertaResponse = await guardarAlertaNotificacion({
            didNotificaciones,
            token,
            imageUrl,
            sev: status?.sev ?? "verde",
            porcentajeError: status?.pctMax,
            afectados: status?.afectados ?? [],
            satResumen: satProcesosInfo?.summaryText ?? "PROCESOS DB OK",
            satAfectados: satProcesosInfo?.affected ?? [],
            usoCpu: status?.cpu,
            usoRam: status?.ram,
            usoDisco: status?.disk,
            pctMax: status?.pctMax,
        });
        console.log(
            `Alerta guardada. did_notificaciones=${didNotificaciones} sev=${status?.sev ?? "verde"
            } respuesta=${JSON.stringify(alertaResponse)}`
        );
    } catch (alertaError) {
        console.error(
            "No se pudo guardar alerta de notificacion:",
            alertaError?.message || alertaError
        );
    }

    return { didNotificaciones };
}

async function procesarEnvioResumen({
    token,
    dia,
    titulo,
    cuerpo,
    nombre,
    messageType,
    logPrefix = "",
}) {
    const resumen = await cargarResumenBase(dia);
    logResumen(logPrefix, resumen.metricas, resumen.satProcesosInfo);

    const currentHash = sha256(stableStringify(resumen.logicalPayload));
    const lastHash = await getLastHash(token);

    if (lastHash && lastHash === currentHash) {
        return {
            skipped: true,
            logicalPayload: resumen.logicalPayload,
            resumen,
        };
    }

    const { imageUrl, tiempoImagenMs, status } = await generarImagenYSubir({
        ...resumen,
        nombre,
    });

    const message =
        messageType === "push"
            ? buildPushMessage({
                token,
                ...resumen,
                status,
                imageUrl,
                titulo,
                cuerpo,
            })
            : buildCronMessage({
                token,
                ...resumen,
                status,
                imageUrl,
            });

    const fcmResponse = await enviarMensajeFcm(message);
    await setLastHash(token, currentHash);

    await guardarMetricasEnvio({
        token,
        imageUrl,
        ...resumen,
        status,
        peorPct: resumen.peorPct,
        tiempoImagenMs,
    });

    return {
        ok: true,
        fcmResponse,
        imageUrl,
        status,
        tiempoImagenMs,
        resumen,
    };
}

export const enviarResumenCantidadPush = async (req, res) => {
    const { token, dia, titulo, cuerpo, nombre } = req.body;

    if (!dia) return res.status(400).json({ ok: false, msg: "Faltan parametros: dia" });
    if (!token) return res.status(400).json({ ok: false, msg: "Faltan parametros: token" });

    try {
        const result = await procesarEnvioResumen({
            token,
            dia,
            titulo,
            cuerpo,
            nombre,
            messageType: "push",
        });

        if (result.skipped) {
            return res.json({
                ok: true,
                skipped: true,
                msg: "Sin cambios relevantes (a 10 mil / severidad): no se envia notificacion.",
                logicalPayload: result.logicalPayload,
            });
        }

        const { resumen } = result;
        return res.json({
            ok: true,
            fecha: resumen.fecha,
            mes: resumen.mes,
            cantidadDia: resumen.cantidadDia,
            cantidadMes: resumen.cantidadMes,
            anioCantidad: resumen.anioCantidad,
            imageUrl: result.imageUrl,
            status: result.status,
            metricas: resumen.metricas,
            satProcesosInfo: resumen.satProcesosInfo,
            fcmResponse: result.fcmResponse,
            logicalPayload: resumen.logicalPayload,
            peorPct: resumen.peorPct,
            tiempoImagenMs: result.tiempoImagenMs,
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

export const obtenerUltimaAlertaResumenV2 = async (_req, res) => {
    try {
        const [alertas, detalle] = await Promise.all([
            obtenerAlertasGuardadas(1),
            obtenerUltimoDetalleGuardado(),
        ]);

        if ((!alertas || alertas.length === 0) && !detalle) {
            return res.status(404).json({
                ok: false,
                version: "v2",
                msg: "No hay alertas ni detalles guardados todavía.",
            });
        }

        const alerta = alertas?.[0] ?? {};
        return res.json(
            buildAlertaResumenV2({
                alerta,
                detalle: matchDetalleParaAlerta(alerta, detalle ?? {}),
            })
        );
    } catch (error) {
        console.error("Error obteniendo alerta v2:", error);
        return res.status(500).json({
            ok: false,
            version: "v2",
            msg: "No se pudo obtener el resumen de la ultima alerta.",
            error: String(error?.message || error),
        });
    }
};

export const obtenerPeorPctResumenV2 = async (req, res) => {
    try {
        const limit = parseLimit(req?.query?.limit, 30);
        const rows = await obtenerPeorPctGuardado(limit);

        return res.json({
            ok: true,
            version: "v2",
            limit,
            count: rows.length,
            items: rows.map(buildPeorPctItemV2),
        });
    } catch (error) {
        console.error("Error obteniendo peor-pct v2:", error);
        return res.status(500).json({
            ok: false,
            version: "v2",
            msg: "No se pudo obtener el resumen de peor porcentaje.",
            error: String(error?.message || error),
        });
    }
};

export async function generarYEnviarResumen({ token, dia }) {
    const result = await procesarEnvioResumen({
        token,
        dia,
        messageType: "cron",
        logPrefix: "(cron)",
    });

    if (result.skipped) {
        console.log("Sin cambios relevantes (a 10 mil / severidad): no se envia notificacion.");
        return {
            skipped: true,
            logicalPayload: result.logicalPayload,
        };
    }

    return {
        ok: true,
        resp: result.fcmResponse,
        imageUrl: result.imageUrl,
        logicalPayload: result.resumen.logicalPayload,
        peorPct: result.resumen.peorPct,
        tiempoImagenMs: result.tiempoImagenMs,
    };
}
