import axios from "axios";
import admin from "firebase-admin";
import path from "path";
import fs from "fs/promises";
import { createCanvas } from "canvas";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

    // IMPORTANTE: guardá con extensión .png
    const fileName = `resumen_${String(fecha).replace(/[^0-9a-zA-Z_-]/g, "-")}_${Date.now()}.png`;
    const outDir = path.join(__dirname, "..", "imagenes");
    await fs.mkdir(outDir, { recursive: true });

    const outPath = path.join(outDir, fileName);
    await fs.writeFile(outPath, canvas.toBuffer("image/png"));

    return { fileName, outPath };
}

async function subirImagenSAT({ nombre, outPath }) {
    const buffer = await fs.readFile(outPath);
    const base64 = buffer.toString("base64");

    // Tal cual Postman: JSON raw
    const payload = {
        foto: `image/png;base64,${base64}`, // <- este prefijo es CLAVE
        nombre: String(nombre),            // <- ej "1231"
    };

    const resp = await axios.post(
        "https://files.lightdata.app/sat/guardarFotosSAT.php",
        payload,
        {
            timeout: 20000,
            headers: { "Content-Type": "application/json" },
            responseType: "text", // por las dudas, suele devolver texto plano (la URL)
        }
    );

    const data = resp.data;

    // En tu Postman devuelve un string con la URL
    const url = typeof data === "string" ? data.trim() : (data?.url ?? "").trim();

    if (!url) {
        throw new Error(`Respuesta inválida de guardarFotosSAT.php: ${JSON.stringify(data)}`);
    }

    return { url };
}

// POST /imagenes/cantidad/push
export const enviarResumenCantidadPush = async (req, res) => {
    const { token, dia, titulo, cuerpo, nombre } = req.body;

    if (!dia) {
        return res.status(400).json({ ok: false, msg: "Faltan parámetros: dia" });
    }

    try {
        const { fecha, cantidad } = await obtenerCantidad(dia);

        const { fileName, outPath } = await generarImagenResumen({ fecha, cantidad });

        // Si querés que el nombre sea "1231" como Postman, mandalo en req.body.nombre.
        // Si no viene, uso uno basado en el filename sin extensión.
        const nombreSAT =
            nombre ?? fileName.replace(/\.[^/.]+$/, ""); // saca ".png"

        const { url: imageUrl } = await subirImagenSAT({ nombre: nombreSAT, outPath });

        // borrar el archivo local
        await fs.unlink(outPath).catch(() => { });

        const message = {
            token,
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

        const fcmResponse = await admin.messaging().send(message);

        return res.json({ ok: true, fecha, cantidad, imageUrl, fcmResponse });
    } catch (error) {
        console.error(error);
        return res.status(500).json({
            ok: false,
            msg: "Error generando/enviando resumen",
            error: String(error?.message || error),
        });
    }
};
