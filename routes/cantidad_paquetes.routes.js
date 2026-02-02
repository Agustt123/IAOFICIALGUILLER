import { Router } from "express";
import { obtenerCantidad } from "../controllers/cantidad_paquetes.controller.js";

const cantidad = Router();

cantidad.post('/', async (req, res) => {

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
export default cantidad;
