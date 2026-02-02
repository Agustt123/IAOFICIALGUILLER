import cron from 'node-cron';
import { obtenerDispositivosActivos } from '../controllers/device.controller.js';
import { generarYEnviarResumen } from '../controllers/cantidad_paquetes.controller.js';

//cron.schedule('1 * * * *', async () => {
cron.schedule("* * * * *", async () => {
    try {
        console.log("⏱️ Cron resumen ejecutándose");

        const dia = new Date().toISOString().slice(0, 10);

        const dispositivos = await obtenerDispositivosActivos();
        console.log(`Dispositivos activos: ${dispositivos.length}`);
        if (!dispositivos.length) return;

        for (const d of dispositivos) {
            await generarYEnviarResumen({
                token: d.token,
                dia,
            });
        }

        console.log("✅ Resumen enviado");
    } catch (e) {
        console.error("❌ Error en cron", e);
    }
});