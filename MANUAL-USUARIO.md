# Manual de uso diario del panel Mews ⇄ Odoo

*Para quien ejecuta las fases cada día desde el panel — no hace falta saber nada de
programación para seguir este manual.*

El panel se abre en el navegador (una URL propia por propiedad) y muestra 5 tarjetas, una debajo
de otra. El trabajo diario consiste en recorrerlas de arriba a abajo, en este orden, cada día
laborable (lunes a viernes). Si un día se acumula trabajo de más de un día, no pasa nada — se
procesa igual, solo puede tardar un poco más.

## Antes de nada: el ritual diario, tarjeta por tarjeta

**1️⃣ Facturas.** Tres botones, en este orden:

1. **🗺️ Cargar reservas** — trae las reservas nuevas de Mews antes que nada. Hace falta hacerlo
   primero porque las facturas usan el localizador de la reserva, y si no está cargado, la factura
   sale sin él.
2. **📂 Cargar facturas nuevas** — trae los informes de cierre (Accounting Closed) pendientes y los
   convierte en filas de factura, todavía sin enviar a Odoo.
3. **📤 Enviar facturas a Odoo** — envía a Odoo las que están pendientes. Aquí es donde se crean de
   verdad, en borrador, y donde se comprueba automáticamente el cuadre Gross de cada una.

   > ⚠️ **Problema conocido en Ibiza Rocks Hotel**: al tener más habitaciones que Pikes, genera
   > muchas más facturas al día, y este paso puede cortarse a medias sin terminar de enviarlas
   > todas. No es grave — no se pierde ni se duplica nada, basta con pulsar el botón otra vez para
   > que continúe con lo que falte — pero es molesto de ver. Si el resultado del botón parece
   > incompleto (muchas menos facturas enviadas de las esperadas, o se queda cargando mucho más de
   > lo habitual), vuelve a pulsarlo.

**⚖️ Cuadre Gross.** A diferencia de las demás tarjetas, aquí **es habitual que haya algo que
hacer casi todos los días** — unos pocos céntimos de diferencia entre Mews y Odoo (por cómo cada
uno redondea el IVA) aparecen con frecuencia, no es una excepción. El cuadre de las facturas
nuevas ya se comprueba solo al enviarlas (paso anterior); esta tarjeta es donde se corrigen esas
discrepancias con "🧮 Corregir redondeos pequeños" (para las que entran dentro del margen
configurado) o se revisan a mano las que no.

**💶 Cobros (Fase 2).** Un botón: **💶 Cargar cobros de Mews** — trae el Payment Report del día y
genera el asiento de cobros. No depende de las facturas, así que puede ejecutarse aunque la
tarjeta de Facturas no tenga nada pendiente ese día.

**✅ Saldar facturas (Fase 4).** Un botón: **✅ Saldar facturas** — concilia las facturas ya creadas
contra los pagos reales que llegaron en el Closed. Solo puede saldar facturas que ya estén creadas
en Odoo, así que va después de la tarjeta de Facturas.

**🏦 Consumir anticipos (Fase 5).** Un botón: **🏦 Consumir anticipos** — la última tarjeta, y
depende de que Saldar ya haya conciliado los pagos de tipo anticipo ese día.

Cada botón, al pulsarlo, se desactiva y muestra un spinner ("Procesando… puede tardar un rato si
hay varios archivos"). Al terminar, aparece un recuadro verde con el resultado si fue bien, o rojo
con el mensaje de error si algo falló — y el estado de todas las tarjetas se actualiza solo. El
botón **🔄 Actualizar estado**, arriba de todo, refresca los números sin ejecutar nada, por si se
quiere comprobar el estado sin lanzar ninguna acción.

## 1. Qué significa cada número que aparece en las tarjetas

Cada línea de estado tiene un círculo de color (el "badge") con un número dentro, y un texto al
lado. Los colores no son decorativos — cada uno significa algo distinto:

| Color | Significado |
| --- | --- |
| 🟢 Verde | Todo en orden — nada que hacer. |
| 🟡 Amarillo | Hay algo pendiente de procesar — es normal verlo antes de ejecutar la acción del día, no tiene por qué ser un problema. |
| 🔴 Rojo | Necesita revisión — algo ha fallado. |
| ⚪ Gris | Informativo, ninguna acción requerida por sí solo. |

### 1️⃣ Facturas — qué ves y qué significa

- **JSON(s) de Reservations pendiente(s) en Drive** (🟡 si hay, 🟢 si no): reservas nuevas de Mews
  todavía sin cargar. Se resuelve pulsando "🗺️ Cargar reservas".
- **JSON(s) de Closed pendiente(s) en Drive** (🟡 si hay, 🟢 si no): informes de cierre nuevos
  todavía sin cargar. Se resuelve pulsando "📂 Cargar facturas nuevas".
- **factura(s) pendiente(s) de enviar a Odoo** (🟡 si hay, ⚪ si no): filas ya en `FACTURAS` con
  estado `PENDIENTE`, listas para el paso "📤 Enviar facturas a Odoo".
- **factura(s) ya creada(s) en Odoo** (siempre 🟢): es un contador acumulado, no una alerta —
  simplemente informa de cuántas hay ya creadas en total.
- **factura(s) con error — revisa la columna notas** (🔴, solo aparece si hay alguna): esta es la
  única línea de esta tarjeta que exige mirar la hoja directamente — hay que abrir `FACTURAS`,
  buscar las filas en estado `ERROR` y leer su columna `notas`, que explica el motivo exacto
  (una serie sin diario en CONFIG, un NIF que no resolvió, etc.).

Si cualquiera de las dos primeras líneas sale "No se pudo comprobar Drive (revisa CONFIG)" en vez
de un número, es un problema de configuración (`FOLDER_ID_INBOX`), no de datos del día — avisar al
equipo técnico.

### ⚖️ Cuadre Gross

- **discrepancia(s) de Gross pendiente(s) de revisar/corregir** (🟡 si hay, 🟢 si no): diferencias
  entre el importe bruto de Mews y el total real en Odoo. Si aparece alguna, revisar primero si
  está dentro del margen de redondeo configurado (se resuelve con "🧮 Corregir redondeos
  pequeños"); si es una diferencia mayor, no es un simple redondeo — hay que revisarla a mano en
  la pestaña `CUADRE_GROSS`.

### 💶 Cobros (Fase 2)

- **Payment report(s) pendiente(s) en Drive** (🟡 si hay, 🟢 si no): informes de cobro del día
  todavía sin procesar. Se resuelve con "💶 Cargar cobros de Mews".

### ✅ Saldar facturas (Fase 4)

- **pago(s) pendiente(s) de conciliar** (🟡 si hay, 🟢 si no): pagos ya extraídos de un Closed que
  todavía no se han cruzado contra su factura. Se resuelve con "✅ Saldar facturas".

  > 💡 **Recomendación (no forma parte del proceso obligatorio)**: si aquí se acumulan pagos
  > pendientes de la misma factura varios días seguidos, puede valer la pena comprobar a quién se
  > facturó esa bill — a veces el sistema deja un pago sin saldar a propósito porque detecta que
  > la factura no se asignó a la agencia/cliente que tocaba (p. ej. cayó en "Clientes Varios").
  > Esto no es un check que el proceso exija, pero es una buena práctica para quien lleve sus
  > propias pestañas de revisión.

### 🏦 Consumir anticipos (Fase 5)

- **pago(s) ya conciliado(s) pendiente(s) de agregar en Fase 5** (🟡 si hay, 🟢 si no): pagos que
  Saldar ya concilió y que corresponden a un anticipo, pero que todavía no se han agrupado en su
  propio asiento. Se resuelve con "🏦 Consumir anticipos".

## 2. Cómo detectar si algo parece incorrecto

- **Si al terminar el ritual diario alguna tarjeta se queda con un número amarillo que no baja de
  un día para otro**, es la señal más clara de que algo necesita atención — no debería acumularse
  de forma indefinida.
- **Cualquier recuadro rojo tras pulsar un botón** es un fallo que hay que leer con calma: el
  mensaje suele decir exactamente qué falta (una clave de CONFIG, una serie sin mapear, un código
  de pago sin cuenta asociada).
- **Facturas en `ERROR`** (badge rojo de la primera tarjeta): revisar la nota antes de reintentar.
  Si el motivo ya está corregido en CONFIG, se puede reintentar desde el menú de la hoja
  ("🔄 Reintentar facturas con error") — esto no está disponible como botón en el panel.
- **(Recomendación, opcional) Pagos que se quedan `PENDIENTE` en Saldar varios días seguidos para
  la misma factura**: puede ser el sistema protegiéndose de una factura mal asignada — quien lleve
  sus propias pestañas de revisión puede comprobar la columna `agencia` de esa factura en
  `FACTURAS` antes de asumir que es un fallo del proceso. No es un check que el proceso exija.
- **En Ibiza Rocks Hotel, si "📤 Enviar facturas a Odoo" termina con muchas menos facturas de las
  esperadas o tarda muchísimo**: es el problema conocido de corte a medias por volumen (ver arriba)
  — vuelve a pulsar el botón, no hace falta avisar a nadie por esto salvo que se repita de forma
  que impida terminar el día.

## 3. A quién avisar

El criterio es el mismo que en la guía general del proceso (`GUIA-NEGOCIO.md`, sección *"¿Qué
hacer si algo falla?"*), aplicado a lo que se ve en el panel:

| Lo que ves | A quién avisar |
| --- | --- |
| Facturas en `ERROR`, o un recuadro rojo tras un botón que menciona CONFIG, series o cuentas | Equipo financiero/contable. |
| "No se pudo comprobar Drive" en cualquier tarjeta, o un error que menciona conexión con Odoo | Equipo técnico. |
| Una bill que no se cierra en Mews, o se cerró a la agencia equivocada | Equipo de Reservas. |
| Una factura facturada mal (p. ej. a "Clientes Varios") | Equipo financiero/contable — no intentar corregirla desde el panel. |

Al avisar, lleva preparado: qué tarjeta y qué botón, el mensaje exacto del recuadro (rojo o
amarillo persistente), y la fecha/bill afectados si se sabe.

## 4. Recordatorio final

Cada día laborable, las 5 tarjetas en orden: **Facturas → Cuadre Gross → Cobros → Saldar →
Anticipos**. Dentro de Facturas, los 3 botones en su propio orden: **Cargar reservas → Cargar
facturas nuevas → Enviar facturas a Odoo**. Si un día no se hace, no pasa nada grave — se retoma
al día siguiente y el sistema no duplica lo ya procesado — pero cuanto más se acumule, más tardará
en procesarse de una vez.
