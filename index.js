import express from "express";
import admin from "firebase-admin";
import fs from "fs";

import fcmRoutes from "./routes/fcm.routes.js";
import deviceRoutes from "./routes/device.routes.js";
import pingRoutes from "./routes/ping.routes.js";
import imagenesRoutes from "./routes/imagenes.routes.js";
import path from "path";
import { fileURLToPath } from "url";
import cantidad from "./routes/cantidad_paquetes.routes.js";
import './uttils/cantidadPaquetes.cron.js';



// ---- Cargar clave privada de Firebase ----
const serviceAccount = JSON.parse(
    fs.readFileSync("./fcm/firebase-key.json", "utf8")
);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use("/imagenes/files", express.static(path.join(__dirname, "imagenes")));
// Rutas API
app.use("/fcm", fcmRoutes);
app.use("/device", deviceRoutes);
app.use("/ping", pingRoutes);
app.use("/imagenes", imagenesRoutes);
app.use("/cantidad-paquetes", cantidad);

app.listen(13001, () => {
    console.log("🚀 LightData FCM API ON - Puerto 13001");
    console.log("→ POST /device/register     (registrar token)");
    console.log("→ POST /fcm/send            (enviar push por token)");
});
