# Mews → Odoo (proyecto nuevo — arranque julio 2026)

Reconstrucción "de uno en uno". Esta primera entrega es solo **Facturas**
(antes llamada "Fase 1"). Cobros y Conciliación se añaden después, cada
una en su propio ciclo de construir → validar → cutover.

El equipo sigue usando la hoja vieja hasta que esta quede validada con
los datos reales de julio. No hay solapamiento: cuando se valida, se
apaga la vieja y se pasa a esta.

## 1. Crear la hoja de Google Sheets

Crea una hoja nueva con estas pestañas (nombres exactos, mayúsculas):

- `CONFIG` — 2 columnas: clave | valor
- `FACTURAS` — cabeceras en la fila 1, datos reales desde la fila 2
  (sin filas en blanco entre medias — el código ya no asume ninguna
  leyenda reservada, así que si quieres notas para el equipo ponlas
  en otra pestaña o a la derecha de las columnas de datos)
- `FACTURAS_LINEAS`
- `LOG_IMPORT`
- `PARTNER_CACHE`
- `AGENCIAS` (opcional, solo si hay agencias con facturación directa)
- `COMPANY_CACHE` (opcional, datos completos de empresas conocidas)

`RESERVAS` y `HUECOS_NUMERACION` las crea el script solas la primera vez
que hacen falta — no hay que crearlas a mano.

Cabeceras de `FACTURAS` (fila 1, columna A a S):
```
bill_mews | bill_odoo | serie | num_factura | fecha_cierre | reservation_number |
localizador_ota | agencia | cliente_nif | cliente_nombre | partner_odoo_id |
num_lineas | importe_bruto | iva_rate | continuidad | estado | odoo_invoice_id |
fecha_procesado | notas
```

Cabeceras de `FACTURAS_LINEAS` (fila 1, columna A a K):
```
bill_mews | linea_num | mews_code | descripcion | vat_rate | net | vat_amount |
amount_bruto | odoo_product_id | odoo_tax_id | serie
```

## 2. Pegar el código

Extensiones → Apps Script → crea un archivo `.gs` por cada archivo de
esta carpeta (mismo nombre) y pega el contenido tal cual.

## 3. Configurar

En **Apps Script → Configuración del proyecto → Propiedades del script**,
añade:
- `ODOO_API_KEY` → tu API key de Odoo

En la pestaña `CONFIG` de la hoja, como mínimo:
```
odoo_url               https://tuservidor.odoo.com
odoo_db                nombre_base_datos
odoo_user              usuario_tecnico
partner_varios_id      <id del partner "Clientes Varios" en Odoo>
ODOO_COMPANY_ID         <id de la compañía Odoo de ESTA propiedad, p.ej. Ibiza Rocks House>
FISCAL_POSITION_ID     <id de la posición fiscal "España Península" en Odoo>
ANALYTIC_ACCOUNT_ID    <id de la cuenta analítica, se aplica al 100% en cada línea>
BILL_TYPE_EXCLUIR      <opcional, códigos de "Bill type code" a excluir, separados por |, ej. HIP>
HUESPEDES_SHEET_ID     <opcional, id de la hoja aparte de Huéspedes (ver ese proyecto)>
FOLDER_ID_INBOX         <id carpeta Drive de entrada>
FOLDER_ID_PROCESADOS    <id carpeta Drive de archivo>
```

`HUESPEDES_SHEET_ID`: opcional. Si se pone, cuando una factura no tiene
NIF se consulta esa hoja (proyecto aparte, ver `mews-huespedes`) por
nombre exacto — si el huésped tiene pasaporte registrado ahí, se usa
como NIF efectivo (mismo circuito que un NIF real: agencia, caché,
búsqueda en Odoo, creación con umbral) y se rellena el país en Odoo.
Si no se pone, o no encuentra coincidencia, sigue el comportamiento
anterior (emparejar solo por nombre en Odoo, sin país).

`BILL_TYPE_EXCLUIR`: opcional. Mews tiene bills técnicos internos (ej.
"Tests / Cross-settlements", que siempre netean a 0) marcados con un
`Bill type code` propio (ej. `HIP`). Por defecto no se excluye nada —
si no lo configuras, esos bills intentarán convertirse en factura y
probablemente fallen con "Serie X sin diario en CONFIG" (ruidoso pero
no peligroso). Si quieres que se salten en silencio, añade su código
aquí, ej. `BILL_TYPE_EXCLUIR = HIP`.

`ANALYTIC_ACCOUNT_ID`: obligatoria. Es una única cuenta fija que se
aplica al 100% de cada línea de cada factura — no varía según el tipo
de servicio. Sin ella, la factura no se crea (antes en el repo viejo
se creaba igual mente sin distribución si faltaba, ahora frena).

`FISCAL_POSITION_ID`: la mayoría de clientes del hotel son extranjeros,
pero el servicio se presta en España, así que deben tributar con IVA
español normal — no con el que Odoo asignaría por defecto a un cliente
de otro país si tiene posiciones fiscales con auto-detección activada.
Se fija tanto en el cliente (por si alguien edita algo a mano en Odoo
más adelante) como en la propia factura en el momento de crearla.
Para encontrar el id: Contabilidad → Configuración → Posiciones
Fiscales → abre "España Península" → el id está en la URL.

`ODOO_COMPANY_ID` es importante en un Odoo multi-compañía (varias
propiedades del mismo grupo en la misma base de datos): sin ella, un
cliente creado automáticamente quedaría compartido para todo el grupo
en vez de privado a esta propiedad. Con ella, tanto los clientes
creados como las propias facturas quedan explícitamente asignados a
la compañía de esta propiedad, y la búsqueda de duplicados/clientes
existentes también se filtra por compañía.

Los `VAT_`, `SERIE_`, `PROD_`, `DESC_` se van añadiendo según vayan
apareciendo códigos al reprocesar julio — no hace falta rellenarlos
todos el primer día. El menú "Enviar facturas a Odoo" te dirá
exactamente qué falta si intenta procesar algo sin mapear.

Opcional: `UMBRAL_CREACION_CLIENTE` (por defecto 3000 si no se pone).
Solo se crea un cliente nuevo en Odoo automáticamente si la factura
supera este importe; por debajo, y si el cliente no existe ya en
Odoo/agencias/caché, va a Clientes Varios. Si el cliente ya existe
por cualquier otra vía, se usa igual sin importar el importe.

Si la factura supera el umbral pero NO hay NIF/CIF en absoluto (huésped
sin identificación fiscal en Mews), se intenta emparejar por el nombre
exacto (`Owner`) antes de rendirse a Clientes Varios. Sin NIF no hay
clave estable, así que es un intento best-effort: una variación en el
nombre no lo va a encontrar. Si no encuentra coincidencia, crea un
cliente nuevo como persona (no empresa) igualmente, y queda marcado en
`notas` como "creado SIN NIF" para que el equipo lo revise si aparece
un NIF real más adelante.

## 4. Desplegar el webhook

Implementar → Nueva implementación → Aplicación web. **Una sola vez**
— Apps Script siempre ejecuta `doPost(e)` sin importar cuántos
despliegues hagas, así que no hay "una función por reporte". El
propio `doPost(e)` mira el contenido del JSON y decide solo si es
Accounting Closed, Created, Payment o Reservations.

Apunta esa misma URL en Mews para las 4 suscripciones (Accounting
Closed, Accounting Created, Payment Report, Reservations), si Mews te
deja usar la misma URL para varias. Si Mews exige una URL distinta
por suscripción, puedes crear varios despliegues — no pasa nada, cada
uno ejecuta el mismo `doPost(e)` y detecta el tipo igual.

## 5. Reprocesar julio

Sube manualmente a la carpeta de Drive (`FOLDER_ID_INBOX`) los JSON de
Accounting Closed desde el día 1 de julio (o espera a que lleguen por
webhook si Mews permite reenviarlos). Luego, desde el menú:
"1️⃣ Cargar facturas nuevas de Mews" → revisa la pestaña FACTURAS →
"2️⃣ Enviar facturas a Odoo".

## 6. Validar antes de pasar el equipo aquí

Antes del cutover, comprobación mínima: que el total facturado de julio
en esta hoja cuadre contra el resumen de Mews. Con eso vale — no hace
falta un sistema en paralelo.

## Qué se dejó fuera a propósito (de momento)

- Cobros (Fase 2) y Conciliación (Fase 4): se construyen después,
  cada una en su propio ciclo.
- Herramientas de diagnóstico manual (consultar diarios/impuestos/
  productos en Odoo, importación manual de reservas, gestión de
  agencias): existían en el repo viejo pero no son parte del flujo
  diario del equipo. Se pueden añadir si hacen falta.

## Comprobación de cuadre Gross (Mews vs Odoo)

**Se detecta automáticamente al importar** — justo después de crear
cada factura, reutilizando la misma lectura que ya se hacía para el
nombre/partner (sin llamada extra a Odoo), se compara el
`importe_bruto` que reportó Mews contra el `amount_total` real en
Odoo. Cualquier discrepancia ≥0,01€ queda registrada en la pestaña
`CUADRE_GROSS` al momento — no hace falta ningún paso manual aparte
para las facturas nuevas.

Odoo recalcula el IVA él solo (base × tipo), no usa el que ya trae
Mews en el JSON, así que pueden aparecer diferencias de 1-2 céntimos
por redondeos distintos entre los dos sistemas — esto es normal en
cualquier integración entre dos motores de cálculo independientes, no
significa que algo esté roto.

Menú → "⚖️ Repasar cuadre Gross (facturas antiguas)" — esto ya NO hace
falta para facturas nuevas (se detectan solas), pero sirve para
repasar facturas que se crearon antes de tener esta detección
integrada, o para forzar un repaso completo bajo demanda. No duplica
filas: si una factura ya está en `CUADRE_GROSS`, la salta.

Esta comprobación NO fuerza que coincidan (eso sería pelearse con el
motor de impuestos de Odoo, frágil) — solo detecta y lista cada
discrepancia para revisión manual antes de saldar cobros.

### Corrección automática de redondeos pequeños

Menú → "🧮 Corregir redondeos pequeños" — para las discrepancias
dentro de `MARGEN_REDONDEO` (CONFIG, ej. `0.05` = 5 céntimos), añade
una línea de ajuste a la factura (todavía en borrador) contra la
cuenta `CUENTA_REDONDEO_ID` (CONFIG), sin IVA, por el importe exacto
que falta o sobra — el total en Odoo pasa a coincidir exactamente con
Mews. Las que superen el margen NO se tocan automáticamente, quedan
marcadas para que alguien las mire a mano.

CONFIG necesario:
```
CUENTA_REDONDEO_ID     <id de la cuenta contable para diferencias de redondeo>
MARGEN_REDONDEO        <margen en euros, ej. 0.05>
```

## Fase 2 — Cobros (nuevo)

Procesa el "Payment report" de Mews y crea **un asiento contable diario**
por cada JSON, agrupado por `Accounting category` — NO toca cliente ni
factura para nada, es puramente el registro de caja del día.

CONFIG necesario:
```
FASE2_JOURNAL_ID       <id del diario único donde se crean los asientos>

# 3 claves por cada categoría de Mews que uses, ej.:
COBRO_CUENTA_CASH_RECEPTION            <cuenta dedicada>
COBRO_CONTRAPARTIDA_CASH_RECEPTION     <cuenta de contrapartida>
COBRO_ETIQUETA_CASH_RECEPTION          <texto descriptivo del apunte>

COBRO_CUENTA_CARD_RECEPTION            ...
COBRO_CONTRAPARTIDA_CARD_RECEPTION     ...
COBRO_ETIQUETA_CARD_RECEPTION          ...

# (igual para AMEX_RECEPTION, BANK_TRANSFER_SANTANDER, CARD_PAYLANDS,
#  CARD_PIKES_WEB, y cualquier otra categoría nueva que aparezca)
```

Cómo se llega al nombre `<CATEGORIA>`: el texto de `Accounting category`
en mayúsculas, con espacios/guiones convertidos a `_`. Ej.
`"CASH - RECEPTION"` → `CASH_RECEPTION`.

**Cobros y reembolsos van en líneas separadas, sin netear** — un
reembolso usa la misma cuenta dedicada de su categoría, pero en el
Haber (y su contrapartida en el Debe), como línea aparte.

Si aparece una categoría de Mews sin sus 3 claves en CONFIG, el
proceso para con un error claro listando qué falta — no se salta en
silencio ni se inventa una cuenta.

Idempotencia: cada asiento lleva `ref = MEWS-COB/<fecha>`; si ya
existe uno con esa referencia, no se duplica.

Menú → "💶 Cargar cobros de Mews (Fase 2)".

## Fixes aplicados respecto al repo viejo

- `jsonResponse()` estaba usada en 4 sitios y no definida en ningún
  archivo — cualquier webhook fallaba. Ahora está en `03_Utils.gs`.
- `verificarConfig()` estaba duplicada dos veces en el mismo archivo
  (`FASE1.gs`, líneas 944 y 1177) — ahora existe una sola vez.
- Se parte de la rama `agrupacion_por_categoria`, no de `main`, porque
  es la que tiene el fix del signo en abonos y la agrupación de líneas
  por código+IVA ya aplicados.
- El repo viejo documentaba `doPostClosed`/`doPostCreated`/
  `doPostPayment`/`doPostReservations` como si cada uno fuera un
  endpoint desplegable por separado. Apps Script no funciona así:
  cualquier despliegue de "Aplicación web" ejecuta siempre `doPost(e)`.
  Ahora hay un único `doPost(e)` que detecta el tipo de reporte por el
  contenido del JSON — un solo despliegue, no cuatro.
- Si llegan 2-3 llamadas casi a la vez al webhook (reintentos de
  Mews, por ejemplo), sin ningún candado todas podían comprobar
  "¿ya existe?" antes de que ninguna terminara de guardar, y guardaban
  el mismo archivo por duplicado/triplicado en Drive. Ahora `doPost(e)`
  usa `LockService` para que solo una llamada guarde a la vez.
- `reordenarYRecalcularContinuidad()` asumía 6 filas de leyenda en
  blanco (filas 2-7) antes de que empezaran los datos reales en
  FACTURAS, heredado del diseño de la hoja original. Con una hoja sin
  esas filas, las primeras facturas insertadas (en el orden en que
  aparecen en el JSON, no ordenadas) caían en esas filas "reservadas"
  y se excluían en silencio del cálculo de huecos — saliendo como
  huecos falsos aunque la factura sí existiera. Ahora no se asume
  ninguna fila reservada: todo lo que hay bajo la cabecera cuenta.
- `formatearNumeroFactura()` devolvía el texto crudo del `Bill` cuando
  no reconocía el patrón, así que "Cancellations 0000053" (serie PHC
  real, vía `Bill type code`) llegaba a Odoo con ese nombre literal en
  vez de algo con sentido. Ahora, cuando el texto no coincide con la
  serie resuelta, se construye el nombre con la serie real + el número
  (ej. "PHC 0000053") — sin tocar el formato de PHF/RPHF, que ya
  salían bien porque ahí el texto sí coincidía con la serie.
- Al reescribir el proyecto se perdió el respaldo a `Owner tax ID`
  cuando `Associated tax ID` viene vacío (el repo original sí lo tenía
  como segunda fuente de NIF). No cambiaba nada en el JSON de prueba
  concreto (ambos campos vacíos ahí), pero sí podía perder NIFs reales
  en otros días. Ahora se combinan los dos al parsear.
- Se detectó un caso real de error operativo: bills con líneas de
  `Payment` pero SIN ninguna línea `Revenue` (ej. un reembolso
  registrado sin la factura/abono correspondiente). Estos nunca
  llegan a FACTURAS porque no hay nada que facturar, así que antes
  pasaban completamente desapercibidos. Ahora se avisan como filas
  `⚠️` en `HUECOS_NUMERACION` (se preservan entre recálculos, a
  diferencia de los huecos normales que sí se recalculan cada vez).
  Respeta `BILL_TYPE_EXCLUIR` y no avisa de "Payment Bill" (PB), que
  por diseño son solo-pago y no es un error.
- **El bug de "company crossover" al crear clientes**: causado por
  `property_account_position_id` (y otros campos "dependientes de
  compañía" en Odoo) no tener nunca un contexto de compañía explícito
  en las llamadas XML-RPC del proyecto — Odoo los leía/validaba contra
  la compañía por defecto del usuario técnico, no contra
  `ODOO_COMPANY_ID`. Confirmado con pruebas reales (mismo `read()`
  daba `false` sin contexto y el valor correcto con contexto). Ahora
  `odooExec()` fusiona automáticamente `{allowed_company_ids,
  force_company, company_id}` en toda llamada del proyecto — no hace
  falta acordarse de ponerlo sitio por sitio.
- La serie se sacaba solo leyendo el texto de `Bill` (letras+espacio+
  número). Bills reales como "Cancellations 0000053" tienen serie PHC
  según el campo `Bill type code` de Mews, pero su texto no encaja en
  ese patrón — se perdían en silencio. Ahora se usa `Bill type code`
  como fuente fiable (con el texto como respaldo si viene vacío). Estos
  bills con numeración propia (secuencia separada de la serie normal,
  ej. cancelaciones con su propio contador 0XXXXXX frente al 2000XXX
  normal) se comprueban como su propia secuencia independiente — se
  siguen detectando huecos, solo que sin mezclarse con la numeración
  correlativa normal de esa serie.
