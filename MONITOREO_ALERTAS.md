# Monitoreo y Alertas

## Resumen

El sistema genera un estado general de monitoreo combinando 3 fuentes:

- `microservicios`
- `servidor`
- `procesos DB`

Con esas 3 fuentes se calcula una severidad final:

- `verde`
- `amarillo`
- `naranja`
- `rojo`

La regla general es:

- `verde`: todo bien, no genera alerta extra
- `amarillo`: hay atención, genera alerta
- `naranja`: hay riesgo alto, genera alerta
- `rojo`: estado crítico, genera alerta

## Frecuencia

El cron corre cada `1 minuto`.

Archivo: [uttils/cantidadPaquetes.cron.js](c:/Users/agust/OneDrive/Escritorio/TRABAJOGUILLE/IAOFICIAL/uttils/cantidadPaquetes.cron.js)

Además:

- si la ejecución anterior sigue corriendo, la siguiente se omite
- si el estado lógico no cambió para un token, no vuelve a mandar la misma notificación

## Flujo general

En cada ejecución:

1. Se obtiene la cantidad del día
2. Se obtienen métricas del servidor
3. Se obtienen procesos DB
4. Se arma un resumen con severidad final
5. Si cambió el estado lógico, se envía la notificación
6. Se guarda el detalle en `notificaciones-ultima`
7. Si la severidad no es `verde`, también se guarda una alerta en `alerta`

## Fuentes evaluadas

### 1. Servidor

Se toman estas métricas:

- `CPU`
- `RAM`
- `DISCO`

Se usa el valor más alto de las tres como `pctMax`.

### Umbrales de servidor

- `0 a 49` => `verde`
- `50 a 69` => `amarillo`
- `70 a 79` => `naranja`
- `80 o más` => `rojo`

## 2. Microservicios

Cada microservicio se evalúa por fallas consecutivas.

Un micro se considera en falla cuando:

- el valor es `null`
- el valor es `undefined`
- el valor no es numérico
- el tiempo es mayor a `2000 ms`

### Umbrales de microservicios

- `0` fallas consecutivas => `verde`
- `1` falla consecutiva => `amarillo`
- `2` fallas consecutivas => `naranja`
- `3 o más` fallas consecutivas => `rojo`

## 3. Procesos DB

Se evalúan:

- `ok`
- `error`
- `codigoHttp`
- `latenciaMs`
- `procesos`
- `promedioSegundos`
- `maxSegundos`

### Regla de persistencia

Para evitar ruido:

- errores duros alertan en la primera aparición
- degradaciones suaves solo alertan si se repiten `3 veces`

Se consideran errores duros:

- `ok = false`
- hay `error`
- `codigoHttp >= 500`

Se consideran degradaciones suaves:

- procesos altos
- `maxSegundos`
- `promedioSegundos`
- `latenciaMs`

### Casos que van a rojo

- `ok = false`
- hay `error`
- `codigoHttp >= 500`
- `maxSegundos >= 15`
- `procesos >= 20`

### Casos que van a naranja

- `maxSegundos >= 8`
- `promedioSegundos >= 5`
- `procesos >= 10`

### Casos que van a amarillo

- `maxSegundos >= 4`
- `promedioSegundos >= 2`
- `latenciaMs >= 1500`
- `procesos >= 5`

### Si no entra en ningún caso

- `verde`

## Cómo se decide la severidad final

Se calcula por separado:

- severidad de servidor
- severidad de microservicios
- severidad de procesos DB

La severidad final es la peor de las tres.

Ejemplo:

- servidor `verde`
- microservicios `amarillo`
- procesos DB `naranja`

Resultado final:

- `naranja`

## Porcentaje de error

Hoy el sistema usa estas referencias:

- `verde` => `0`
- `amarillo` => `50`
- `naranja` => `75`
- `rojo` => `99`

Además:

- si `CPU`, `RAM` o `DISCO` tienen un valor más alto, ese valor puede dominar
- si los microservicios tienen rachas peligrosas, también empujan el porcentaje final

### Equivalencias por microservicios

- `1` falla consecutiva => `50`
- `2` fallas consecutivas => `75`
- `3 o más` => `99`

## Cuándo se guarda una alerta

Se guarda una alerta cuando:

- `sev !== "verde"`

Eso significa que:

- `amarillo` guarda alerta
- `naranja` guarda alerta
- `rojo` guarda alerta
- `verde` no guarda alerta

## Endpoints involucrados

### 1. Snapshot

Endpoint:

- `http://dw.lightdata.app/monitoreo/peor-pct`

Uso:

- guarda snapshot resumido

### 2. Notificación detalle

Endpoint:

- `http://dw.lightdata.app/monitoreo/notificaciones-ultima`

Uso:

- guarda el detalle de la notificación enviada
- devuelve el `id` insertado

Respuesta esperada:

```json
{
  "estado": true,
  "data": {
    "estado": true,
    "message": "Notificacion insertada correctamente",
    "id": 123,
    "data": {}
  }
}
```

Ese `id` se usa luego como:

- `did_notificaciones`

### 3. Alerta

Endpoint:

- `http://dw.lightdata.app/monitoreo/alerta`

Uso:

- guarda una alerta asociada a una notificación ya insertada

## Payload de alerta

Campos principales:

- `did_notificaciones`
- `autofecha`
- `sev`
- `porcentaje_error`
- `titulo`
- `resumen_alerta`
- `que_fallo`
- `detalle_alerta`
- `image_url`
- `token`

## Criterio actual para la alerta

La alerta intenta ser simple:

- mostrar severidad
- mostrar porcentaje
- mostrar qué falló
- no llenar de texto con cosas que están bien

### Ejemplo de alerta

```json
{
  "did_notificaciones": 123,
  "autofecha": "2026-03-25T14:30:00.000Z",
  "sev": "naranja",
  "porcentaje_error": 75,
  "titulo": "Alerta de monitoreo",
  "resumen_alerta": "lightdatito: ERROR | produccion: PROCESOS ALTOS (10)",
  "que_fallo": "lightdatito: ERROR | produccion: PROCESOS ALTOS (10) | apilanta: fallas consecutivas (3)",
  "detalle_alerta": {
    "cosas_fallando": [
      "lightdatito: ERROR",
      "produccion: PROCESOS ALTOS (10)",
      "apilanta: fallas consecutivas (3)"
    ],
    "afectados": [
      { "micro": "apilanta", "streak": 3 }
    ],
    "procesos_db_afectados": [
      { "servidor": "lightdatito", "sev": "rojo", "reason": "ERROR" },
      { "servidor": "produccion", "sev": "naranja", "reason": "PROCESOS ALTOS (10)" }
    ]
  },
  "image_url": "https://...",
  "token": "..."
}
```

## Logs útiles

Cuando el flujo corre, hoy pueden aparecer estos logs:

- `Notificacion detalle guardada. did_notificaciones=123 sev=naranja`
- `Alerta guardada. did_notificaciones=123 sev=naranja ...`
- `Alerta omitida. sev=verde did_notificaciones=123`

## Archivos principales

- [controllers/cantidad_paquetes.analysis.js](c:/Users/agust/OneDrive/Escritorio/TRABAJOGUILLE/IAOFICIAL/controllers/cantidad_paquetes.analysis.js)
- [controllers/cantidad_paquetes.controller.js](c:/Users/agust/OneDrive/Escritorio/TRABAJOGUILLE/IAOFICIAL/controllers/cantidad_paquetes.controller.js)
- [controllers/cantidad_paquetes.data.js](c:/Users/agust/OneDrive/Escritorio/TRABAJOGUILLE/IAOFICIAL/controllers/cantidad_paquetes.data.js)
- [uttils/notificacionSnapshot.store.js](c:/Users/agust/OneDrive/Escritorio/TRABAJOGUILLE/IAOFICIAL/uttils/notificacionSnapshot.store.js)
- [uttils/cantidadPaquetes.cron.js](c:/Users/agust/OneDrive/Escritorio/TRABAJOGUILLE/IAOFICIAL/uttils/cantidadPaquetes.cron.js)
