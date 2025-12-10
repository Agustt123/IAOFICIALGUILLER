import { Router } from "express";
import { sendFCM } from "../controllers/fcm.controller.js";

const router = Router();

// POST → Enviar push a un token
router.post("/send", sendFCM);

export default router;
