import express from "express";
import admin from "firebase-admin";
import fs from "fs";

import fcmRoutes from "./routes/fcm.routes.js";
import deviceRoutes from "./routes/device.routes.js";
import pingRoutes from "./routes/ping.routes.js";



// ---- Cargar clave privada de Firebase ----
const serviceAccount = JSON.parse(
    fs.readFileSync("./fcm/firebase-key.json", "utf8")
);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const app = express();
app.use(express.json());

// Rutas API
app.use("/fcm", fcmRoutes);
app.use("/device", deviceRoutes);
app.use("/ping", pingRoutes);

app.listen(3000, () => {
    console.log("🚀 LightData FCM API ON - Puerto 3000");
    console.log("→ POST /device/register     (registrar token)");
    console.log("→ POST /fcm/send            (enviar push por token)");
});
