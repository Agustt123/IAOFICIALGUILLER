import axios from "axios";

const SNAPSHOT_ENDPOINT =
    process.env.NOTIFICACION_SNAPSHOT_URL ?? "http://dw.lightdata.app/monitoreo/peor-pct";
const DETALLE_ENDPOINT =
    process.env.NOTIFICACION_DETALLE_URL ?? "http://dw.lightdata.app/monitoreo/notificaciones-ultima";
const ALERTA_ENDPOINT =
    process.env.NOTIFICACION_ALERTA_URL ?? "http://dw.lightdata.app/monitoreo/alerta";

export async function guardarSnapshotNotificacion({
    autofecha,
    cantidadDia,
    peorPct,
    tiempoImagenMs,
} = {}) {
    const payload = {
        autofecha: autofecha ?? new Date(),
        cantidad_dia: Number(cantidadDia ?? 0),
        peor_pct: Number(peorPct ?? 0),
        tiempo_imagen_ms: Number(tiempoImagenMs ?? 0),
    };

    const { data } = await axios.post(SNAPSHOT_ENDPOINT, payload, {
        timeout: 15000,
        headers: {
            "Content-Type": "application/json",
        },
    });

    return data;
}

export async function guardarDetalleNotificacion({
    autofecha,
    token,
    imageUrl,
    fecha,
    mes,
    cantidadDia,
    cantidadMes,
    anioCantidad,
    hoyMovimiento,
    sev,
    maxStreak,
    afectados,
    usoCpu,
    usoRam,
    usoDisco,
    pctMax,
    satSev,
    satResumen,
    satAfectados,
    peorPct,
    tiempoImagenMs,
} = {}) {
    const payload = {
        autofecha: autofecha ?? new Date(),
        token: token ? String(token) : null,
        image_url: imageUrl ? String(imageUrl) : null,
        fecha: fecha ? String(fecha) : null,
        mes: mes ? String(mes) : null,
        cantidad_dia: Number(cantidadDia ?? 0),
        cantidad_mes: Number(cantidadMes ?? 0),
        anio_cantidad: Number(anioCantidad ?? 0),
        hoy_movimiento: Number(hoyMovimiento ?? cantidadDia ?? 0),
        sev: sev ? String(sev) : "verde",
        max_streak: Number(maxStreak ?? 0),
        afectados: Array.isArray(afectados) ? afectados : [],
        uso_cpu: usoCpu === null || usoCpu === undefined ? null : Number(usoCpu),
        uso_ram: usoRam === null || usoRam === undefined ? null : Number(usoRam),
        uso_disco: usoDisco === null || usoDisco === undefined ? null : Number(usoDisco),
        pct_max: pctMax === null || pctMax === undefined ? null : Number(pctMax),
        sat_sev: satSev ? String(satSev) : "verde",
        sat_resumen: satResumen ? String(satResumen) : null,
        sat_afectados: Array.isArray(satAfectados) ? satAfectados : [],
        peor_pct: Number(peorPct ?? 0),
        tiempo_imagen_ms: Number(tiempoImagenMs ?? 0),
    };

    const { data } = await axios.post(DETALLE_ENDPOINT, payload, {
        timeout: 15000,
        headers: {
            "Content-Type": "application/json",
        },
    });

    return data;
}

export async function guardarAlertaNotificacion({
    didNotificaciones,
    autofecha,
    token,
    imageUrl,
    sev,
    porcentajeError,
    afectados,
    satResumen,
    satAfectados,
    usoCpu,
    usoRam,
    usoDisco,
    pctMax,
} = {}) {
    const afectadosList = Array.isArray(afectados) ? afectados : [];
    const satAfectadosList = Array.isArray(satAfectados) ? satAfectados : [];

    const resumenPartes = [
        satResumen ? String(satResumen) : null,
        afectadosList.length ? `${afectadosList.length} micros afectados` : null,
        satAfectadosList.length ? `${satAfectadosList.length} incidentes procesos DB` : null,
    ].filter(Boolean);

    const queFalloPartes = [
        satResumen ? String(satResumen) : null,
        afectadosList.length
            ? afectadosList.map((item) => `${item.micro} streak ${item.streak}`).join(" | ")
            : null,
        satAfectadosList.length
            ? satAfectadosList
                  .map((item) => `${item.servidor} ${item.reason || item.sev || "alerta"}`)
                  .join(" | ")
            : null,
    ].filter(Boolean);

    const payload = {
        did_notificaciones: Number(didNotificaciones ?? 0),
        autofecha: autofecha ?? new Date(),
        sev: sev ? String(sev) : "verde",
        color: sev ? String(sev) : "verde",
        porcentaje_error:
            porcentajeError === null || porcentajeError === undefined
                ? null
                : Number(porcentajeError),
        titulo: "Alerta de monitoreo",
        resumen_alerta: resumenPartes.join(" | ") || null,
        que_fallo: queFalloPartes.join(" | ") || null,
        detalle_alerta: {
            afectados: afectadosList,
            sat_afectados: satAfectadosList,
            sat_resumen: satResumen ? String(satResumen) : null,
            metricas: {
                uso_cpu: usoCpu === null || usoCpu === undefined ? null : Number(usoCpu),
                uso_ram: usoRam === null || usoRam === undefined ? null : Number(usoRam),
                uso_disco: usoDisco === null || usoDisco === undefined ? null : Number(usoDisco),
                pct_max: pctMax === null || pctMax === undefined ? null : Number(pctMax),
            },
        },
        image_url: imageUrl ? String(imageUrl) : null,
        token: token ? String(token) : null,
    };

    const { data } = await axios.post(ALERTA_ENDPOINT, payload, {
        timeout: 15000,
        headers: {
            "Content-Type": "application/json",
        },
    });

    return data;
}
