import admin from "firebase-admin";
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
            notification: {
                imageUrl,
                channelId: "silent_high",
            },
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
            autofecha: new Date(),
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
            autofecha: new Date(),
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
            `Notificacion detalle guardada. did_notificaciones=${didNotificaciones} sev=${
                status?.sev ?? "verde"
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
            autofecha: new Date(),
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
            `Alerta guardada. did_notificaciones=${didNotificaciones} sev=${
                status?.sev ?? "verde"
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
                msg: "Sin cambios relevantes (a miles / severidad): no se envia notificacion.",
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

export async function generarYEnviarResumen({ token, dia }) {
    const result = await procesarEnvioResumen({
        token,
        dia,
        messageType: "cron",
        logPrefix: "(cron)",
    });

    if (result.skipped) {
        console.log("Sin cambios relevantes (a miles / severidad): no se envia notificacion.");
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
