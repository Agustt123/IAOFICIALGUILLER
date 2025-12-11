export const subirImagenBase64 = (req, res) => {
    const { imagenBase64 } = req.body;

    if (!imagenBase64) {
        return res.status(400).json({
            ok: false,
            msg: "No se envió imagenBase64"
        });
    }

    // Podés procesarla, validarla, enviarla por FCM, guardarla en DB, etc.
    // Por ahora solo devolvemos ok.

    return res.json({
        ok: true,
        msg: "Imagen Base64 recibida",
        length: imagenBase64.length,  // para validar en pruebas
        preview: imagenBase64.substring(0, 30) + "..."
    });
};
import admin from "firebase-admin";

export const enviarImagenBase64Push = async (req, res) => {
    const { token, titulo, cuerpo, imagenBase64 } = req.body;

    if (!token || !imagenBase64) {
        return res.status(400).json({
            ok: false,
            msg: "Faltan parámetros: token o imagenBase64"
        });
    }

    try {
        const message = {
            token,
            notification: {
                title: titulo || "Imagen recibida",
                body: cuerpo || "Tenés un mensaje con imagen"
            },
            data: {
                imageBase64 // le mandamos la imagen en data
            }
        };

        const response = await admin.messaging().send(message);

        return res.json({
            ok: true,
            msg: "Notificación enviada con imagen base64",
            fcmResponse: response
        });

    } catch (error) {
        console.error(error);
        return res.status(500).json({
            ok: false,
            msg: "Error enviando la notificación",
            error
        });
    }
};
