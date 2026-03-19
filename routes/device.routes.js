import { Router } from "express";
import { clearDevices, registerDevice } from "../controllers/device.controller.js";

const router = Router();

router.post("/register", registerDevice); // registrar token
router.post("/clear", clearDevices);

export default router;
