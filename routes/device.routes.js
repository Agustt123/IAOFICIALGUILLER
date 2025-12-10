import { Router } from "express";
import { registerDevice } from "../controllers/device.controller.js";

const router = Router();

router.post("/register", registerDevice); // registrar token

export default router;
