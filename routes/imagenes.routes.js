import { Router } from "express";
import { enviarImagenBase64Push, subirImagenBase64 } from "../controllers/imagenes.controller.js";

const router = Router();

// POST /imagenes/base64
router.post("/base64", subirImagenBase64);
router.post("/base64/push", enviarImagenBase64Push);

export default router;
