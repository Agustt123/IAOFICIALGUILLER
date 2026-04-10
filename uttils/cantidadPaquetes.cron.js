import cron from 'node-cron';
import { obtenerDispositivosActivos } from '../controllers/device.controller.js';
import { generarYEnviarResumen, todayLocalYYYYMMDD } from '../controllers/cantidad_paquetes.controller.js';
//
let cronEnCurso = false;

//cron.schedule('1 * * * *', async () => {
cron.schedule("* * * * *", async () => {
    if (cronEnCurso) {
        console.log("Cron resumen omitido: sigue en curso la ejecución anterior");
        return;
    }

    cronEnCurso = true;

    try {
        console.log("⏱️ Cron resumen ejecutándose");

        const dia = todayLocalYYYYMMDD();
        console.log(`[cron-resumen] dia_consultado=${dia}`);

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
    } finally {
        cronEnCurso = false;
    }
});
