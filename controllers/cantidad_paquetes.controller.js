import axios from "axios";
import admin from "firebase-admin";
import path from "path";
import fs from "fs/promises";
import { createCanvas } from "canvas";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getBaseUrl(req) {
    // si tenés proxy (nginx/cloudflare), esto ayuda
    const protocol = req.headers["x-forwarded-proto"] || req.protocol;
    const host = req.headers["x-forwarded-host"] || req.get("host");
    return `${protocol}://${host}`;
}

async function obtenerCantidad(dia) {
    const { data } = await axios.post("http://dw.lightdata.app/cantidad", { dia }, { timeout: 15000 });

    if (!data?.ok) {
        throw new Error(`Respuesta inválida de /cantidad: ${JSON.stringify(data)}`);
    }

    return {
        fecha: data.fecha ?? dia,
        cantidad: Number(data.cantidad ?? 0),
    };
}

async function generarImagenResumen({ fecha, cantidad }) {
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

    const fileName = `resumen_${String(fecha).replace(/[^0-9a-zA-Z_-]/g, "-")}_${Date.now()}.png`;
    const outDir = path.join(__dirname, "..", "imagenes");
    await fs.mkdir(outDir, { recursive: true });

    const outPath = path.join(outDir, fileName);
    await fs.writeFile(outPath, canvas.toBuffer("image/png"));

    return { fileName };
}

// POST /imagenes/cantidad/push
export const enviarResumenCantidadPush = async (req, res) => {
    const { token, dia, titulo, cuerpo } = req.body;

    if (!dia) {
        return res.status(400).json({ ok: false, msg: "Faltan parámetros: token o dia" });
    }

    try {
        // 1) obtener info desde DW
        const { fecha, cantidad } = await obtenerCantidad(dia);

        // 2) generar imagen y URL
        const { fileName } = await generarImagenResumen({ fecha, cantidad });
        const imageUrl = `${getBaseUrl(req)}/imagenes/files/${fileName}`;

        // 3) enviar push con imagenUrl + data
        const message = {
            token,
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
                priority: "HIGH"

            },

        };
        console.log(message);


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
