# SAT - Documentacion Funcional

## Resumen

SAT es una aplicacion interna orientada al monitoreo preventivo de la salud general del sistema.
Su objetivo es analizar distintos focos operativos y tecnicos para detectar riesgos antes de que
se conviertan en incidentes visibles para la operacion o para el cliente.

Actualmente, el analisis funcional de SAT se concentra principalmente en:

- microservicios
- servidores
- base de datos

La aplicacion toma informacion de estos focos, la interpreta y la resume en un estado general de
salud, priorizando la deteccion temprana y la identificacion del punto afectado.

## Cuadro General

| Nombre | Que se analiza | Como se mide | Se mide actualmente |
| --- | --- | --- | --- |
| Microservicios | Disponibilidad, tiempos de respuesta y fallas consecutivas | Monitoreo periodico de respuestas y deteccion de errores o demoras fuera de umbral | Si |
| Servidores | Estado general de recursos criticos del entorno | Analisis de metricas como CPU, RAM, disco y otras variables de salud | Si |
| Base de datos | Procesos sensibles, lentitud, acumulacion o errores | Evaluacion de procesos y condiciones que indiquen degradacion o riesgo | Si |
| Riesgo general | Estado consolidado del sistema | Interpretacion conjunta de microservicios, servidores y base de datos | Si |

## Informacion Disponible Hoy

Hoy SAT ya cuenta con informacion util para construir el estado general del sistema. A nivel
funcional, la informacion disponible incluye:

### Microservicios

- disponibilidad del servicio
- tiempo de respuesta
- fallas consecutivas
- servicios afectados

### Servidores

- uso de CPU
- uso de RAM
- uso de disco
- latencia
- carga del sistema
- uso de RAM del proceso
- uso de CPU del proceso
- temperatura de CPU en algunos casos

### Base de datos

- estado OK o error
- codigo de respuesta
- latencia
- cantidad de procesos
- duracion maxima
- duracion promedio
- errores detectados

### Consolidado

- severidad general
- focos activos
- porcentaje de riesgo
- peor porcentaje

## Criterios Funcionales por Foco

### Microservicios

#### Que se analiza

- disponibilidad
- tiempo de respuesta
- fallas consecutivas

#### Como se interpreta

- un microservicio en falla no necesariamente implica una caida total, pero si una senal de riesgo
- la reiteracion de fallas consecutivas aumenta la gravedad
- cuanto mas sostenido es el problema, mayor es la severidad funcional

#### Criterio inicial a considerar

- 1 falla consecutiva: atencion
- 2 fallas consecutivas: riesgo alto
- 3 o mas: estado critico

### Servidores

#### Que se analiza

- CPU
- RAM
- disco
- latencia y salud general del entorno

#### Como se interpreta

- CPU y RAM representan presion operativa del servidor
- el disco conviene interpretarlo no solo por uso crudo, sino por nivel de peligro
- la latencia y otras metricas complementan el contexto general

#### Criterio inicial a considerar

- CPU y RAM pueden mantenerse como metricas de uso
- disco puede pasar a una escala de riesgo progresivo

#### Escala propuesta para disco

- hasta 85 por ciento: sin riesgo relevante
- 85 a 89 por ciento: atencion
- 90 a 94 por ciento: riesgo alto
- 95 por ciento o mas: critico

#### Interpretacion funcional de disco

- el uso crudo del disco se mantiene como dato tecnico
- el riesgo de disco se usa para representar que tan peligrosa es la situacion
- esto permite que el sistema no tome igual un 60 por ciento de uso que un 92 por ciento

### Base de datos

#### Que se analiza

- errores
- lentitud
- acumulacion de procesos
- respuesta general

#### Como se interpreta

- errores directos indican criticidad alta
- lentitud o acumulacion pueden indicar degradacion progresiva
- si la condicion se sostiene en el tiempo, aumenta la severidad

#### Criterio inicial a considerar

- error directo: critico
- degradacion leve: atencion
- degradacion sostenida: riesgo alto o critico

## Riesgo General

SAT no busca solamente mostrar datos tecnicos en bruto. Su valor funcional esta en:

- centralizar senales de distintos focos
- resumir la salud general del sistema
- detectar desvio o deterioro antes de una caida
- identificar cual es el foco comprometido
- clasificar la gravedad del problema
- permitir seguimiento mediante alertas

La aplicacion consolida la informacion disponible y la resume en un estado general. Ese estado
puede representarse con:

- verde
- amarillo
- naranja
- rojo

Tambien puede expresarse mediante un porcentaje de riesgo que ayude a mostrar, de manera mas
simple, el nivel real de peligro del sistema.

## Observaciones para seguir trabajando

- este documento esta enfocado en la parte funcional y no en el detalle tecnico de implementacion
- se puede ampliar luego con reglas concretas por foco
- se puede definir mejor el criterio exacto de porcentajes por cada recurso
- tambien se puede separar en monitoreo, alertas, visualizacion y experiencia de usuario
