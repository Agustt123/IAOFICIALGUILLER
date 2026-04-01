import { Router } from "express";
import {
    enviarResumenCantidadPush,
    obtenerCantidad,
    obtenerUltimaAlertaResumenV2,
    obtenerPeorPctResumenV2,
} from "../controllers/cantidad_paquetes.controller.js";

const cantidad = Router();

cantidad.get('/', async (req, res) => {

    const { dia } = req.body || ""

    try {
        const resultado = await obtenerCantidad(dia);
        return res.status(200).json(resultado);
    } catch (error) {
        console.error("Error /:", error);
        return res.status(500).json({ estado: false, mensaje: "Error en el servidor" });
    } finally {

    }
});

cantidad.post('/push', enviarResumenCantidadPush);
cantidad.get('/alerta/v2', obtenerUltimaAlertaResumenV2);
cantidad.get('/peor-pct/v2', obtenerPeorPctResumenV2);

export default cantidad;
