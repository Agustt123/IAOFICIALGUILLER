import axios from "axios";
import admin from "firebase-admin";
import { createCanvas } from "canvas";

async function obtenerCantidad(dia) {
    const { data } = await axios.post(
        "http://dw.lightdata.app/cantidad",
        { dia },
        { timeout: 15000 }
    );

    if (!data?.ok) {
        throw new Error(`Respuesta inválida de /cantidad: ${JSON.stringify(data)}`);
    }

    return {
        fecha: data.fecha ?? dia,
        cantidad: Number(data.cantidad ?? 0),
    };
}

function generarImagenResumenBuffer({ fecha, cantidad }) {
    const width = 900;
    const height = 420;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "#0b1220";
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = "#111b2e";
    ctx.fillRect(40, 40, width - 80, height - 80);

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 36px Arial";
    ctx.fillText("Resumen Global", 80, 115);

    ctx.fillStyle = "#cbd5e1";
    ctx.font = "24px Arial";
    ctx.fillText(`Fecha: ${fecha}`, 80, 165);

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 72px Arial";
    ctx.fillText(`${cantidad}`, 80, 270);

    ctx.fillStyle = "#cbd5e1";
    ctx.font = "24px Arial";
    ctx.fillText("Paquetes únicos", 80, 305);

    // PNG EN MEMORIA (sin fs.writeFile)
    return canvas.toBuffer("image/png");
}

async function subirImagenSAT({ bufferPng, nombre }) {
    const base64 = bufferPng.toString("base64");

    // TAL CUAL POSTMAN: JSON raw con prefijo image/png;base64,
    const payload = {
        foto: `image/png;base64,${base64}`,
        nombre: String(nombre),
    };

    const resp = await axios.post(
        "https://files.lightdata.app/sat/guardarFotosSAT.php",
        payload,
        {
            timeout: 20000,
            headers: { "Content-Type": "application/json" },
            responseType: "text", // devuelve texto con la URL
            transformResponse: (r) => r, // evita que axios intente parsear
        }
    );

    const url = String(resp.data || "").trim();
    if (!url.startsWith("http")) {
        throw new Error(`SAT no devolvió URL válida: ${url}`);
    }

    return url;
}

// POST /imagenes/cantidad/push
export const enviarResumenCantidadPush = async (req, res) => {
    const { token, dia, titulo, cuerpo, nombre } = req.body;

    if (!dia) {
        return res.status(400).json({ ok: false, msg: "Faltan parámetros: dia" });
    }

    try {
        // 1) obtener info desde DW
        const { fecha, cantidad } = await obtenerCantidad(dia);

        // 2) generar imagen EN MEMORIA
        const bufferPng = generarImagenResumenBuffer({ fecha, cantidad });

        // 3) subir a SAT y obtener URL (si no te mandan "nombre", genero uno)
        const nombreSAT =
            nombre ?? `resumen_${String(fecha).replace(/[^0-9a-zA-Z_-]/g, "-")}_${Date.now()}`;

        const imageUrl = await subirImagenSAT({ bufferPng, nombre: nombreSAT });

        // 4) enviar push con URL REAL (NO localhost)
        const message = {
            token,
            // Si querés mostrar notificación:
            notification: {
                title: titulo || "Resumen Global",
                body: cuerpo || `Paquetes: ${cantidad} (${fecha})`,
                imageUrl,
            },
            data: {
                imageUrl,
                fecha: String(fecha),
                cantidad: String(cantidad),
            },
            android: {
                notification: { imageUrl },
                priority: "HIGH",
            },
        };

        console.log("FCM message:", message);

        const fcmResponse = await admin.messaging().send(message);

        return res.json({
            ok: true,
            fecha,
            cantidad,
            imageUrl,
            fcmResponse,
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
