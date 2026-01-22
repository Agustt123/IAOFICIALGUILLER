import { Router } from "express";
import { enviarResumenCantidadPush } from "../controllers/cantidad_paquetes.controller.js";

const cantidad = Router();

cantidad.post("/", enviarResumenCantidadPush);

export default cantidad;
