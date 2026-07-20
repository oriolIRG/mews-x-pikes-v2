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

Las cuentas **dedicadas** llevan una línea por categoría (con su
etiqueta específica). Las **contrapartidas** se agrupan y suman por
cuenta — si varias categorías comparten la misma contrapartida (ej.
Paylands y Pikes Web ambas van a 438100), sale como una sola línea
sumada, con etiqueta genérica (`COBRO_ETIQUETA_GENERICA`, por defecto
"Cobros MEWS del día"; `COBRO_ETIQUETA_GENERICA_REEMBOLSO` para
reembolsos, por defecto "Reembolsos MEWS del día") — igual que en el
asiento real usado de referencia para diseñar esto.

**Cobros y reembolsos van en líneas separadas, sin netear** — un
reembolso usa la misma cuenta dedicada de su categoría, pero en el
Haber (y su contrapartida en el Debe), como línea aparte.

Si aparece una categoría de Mews sin sus 3 claves en CONFIG, el
proceso para con un error claro listando qué falta — no se salta en
silencio ni se inventa una cuenta.

Idempotencia: cada asiento lleva `ref = MEWS-COB/<fecha>`; si ya
existe uno con esa referencia, no se duplica.

Menú → "💶 Cargar cobros de Mews (Fase 2)".

## Fase 4 — Saldar facturas (nuevo)

Concilia cada factura contra sus pagos reales, usando las líneas
`Type: Payment` del mismo Closed report que ya procesa Fase 1 (se
guardan solas en la pestaña `PAGOS_CLOSED` al parsear, sin que haga
falta ningún archivo nuevo). Solo se puede ejecutar cuando las
facturas de esos días ya están **confirmadas** en Odoo, no en
borrador — por eso es una fase aparte y posterior, aunque el dato ya
esté disponible desde Fase 1.

**Sin cuenta de diferencias/redondeo**: como Mews solo cierra un Bill
cuando sus pagos suman exactamente el total, y el cuadre de Gross de
Fase 1 ya garantiza que ese total coincide con Odoo, no hace falta
absorber ninguna diferencia. Si una factura concreta no cuadra exacto,
es una anomalía real — **bloquea el asiento de ese día entero**, no se
procesa parcialmente ni se esconde en una cuenta de ajuste.

CONFIG necesario:
```
FASE4_JOURNAL_ID       <diario del asiento de conciliación>
FASE4_CUENTA_430       <cuenta de Clientes, a conciliar>
FASE4_BILLS_EXCLUIR    <opcional, patrones de Bill a ignorar, separados por |>

# Una cuenta puente por cada código de pago del Closed report (SAN,
# PDQ, CAS, PLD, WEB, AMR...), normalmente las mismas 579012/438100
# que ya usa Fase 2, pero indexadas por el código corto, no por el
# texto largo de Accounting category:
FASE4_CUENTA_SAN       ...
FASE4_CUENTA_PDQ       ...
FASE4_CUENTA_CAS       ...
FASE4_CUENTA_PLD       ...
FASE4_CUENTA_WEB       ...
FASE4_CUENTA_AMR       ...
```

Si un código de pago no tiene `FASE4_CUENTA_<CODE>`, o una factura no
está en `FACTURAS`/confirmada en Odoo, se bloquea el asiento de ese
día completo, con el detalle exacto de qué falta.

**Excepción a propósito**: si el total de pagos de un bill neta a cero
(ej. un cobro fallido + repetido por otro canal, como RPHF000055/56 —
el mismo patrón que "SOLO PAGOS" que ya detecta Fase 1), ese bill se
excluye entero — no hay nada real que conciliar y no debería bloquear
el día. Se excluye tanto del lado de las cuentas puente como del de
clientes, para que el asiento siga cuadrando.

Idempotencia: `ref = MEWS-COB4/<fecha>`, igual que Fase 2 con su
propio prefijo.

Menú → "✅ Saldar facturas (Fase 4)".

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
- `extraerPagosParaFase4()` deduplicaba por presencia
  (bill+código+importe+fecha), no por ocurrencias — dos pagos reales
  y distintos con exactamente los mismos valores (ej. dos cobros de
  tarjeta por la misma cantidad, mismo bill, mismo día) se confundían
  con un duplicado de reprocesado, y el segundo se perdía en silencio.
  Confirmado con un caso real: faltaban exactos 68,09€ en una factura
  con dos pagos PDQ idénticos. Ahora se cuenta cuántas veces aparece
  cada combinación, no solo si existe.
  `Payment` pero SIN ninguna línea `Revenue` (ej. un reembolso
  registrado sin la factura/abono correspondiente). Al principio solo
  se avisaba en `HUECOS_NUMERACION`. Ahora, si sus pagos netean a
  CERO (el caso típico: cobro fallido + repetido por otro canal), se
  crea un documento a 0€ en Odoo con una línea por cada movimiento de
  pago real, todas contra `CUENTA_REDONDEO_ID` — así la numeración no
  deja hueco y las dos patas del error quedan visibles en Odoo, sin
  ningún efecto contable neto real. Solo se sigue avisando (sin crear
  nada) cuando el total NO neteaba a cero — eso sí sigue siendo un
  problema real sin resolver automáticamente.
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
- `odooExec()` cortaba el mensaje de error de Odoo a 400 caracteres
  antes de lanzarlo — en un error normal no se nota, pero en un
  traceback largo (como el de un fallo real al crear un asiento) se
  perdía justo la parte con la línea de código real que falló. Quitado
  el corte, tanto ahí como en los mensajes de error de conciliación de
  Fase 4 (estaban a 80 caracteres).
- Fase 4 leía `fecha_cierre` de `PAGOS_CLOSED` con `String(celda)`
  directamente. Si Sheets auto-convirtió esa celda a tipo Fecha (pasa
  solo con guardar un texto con pinta de fecha ISO), Apps Script la
  devuelve como `Date` de JS al leerla, y `String(esa Date)` da un
  formato tipo "Fri Jul 17 2026..." en vez de "2026-07-17" — Odoo
  rechaza esa fecha de raíz al crear el asiento. Ahora se pasa por
  `formatFechaOdoo()` (la misma función que ya usaba Fase 1 para esto),
  que normaliza bien tanto si llega texto como si llega un `Date`.
- El asiento de Fase 4 salía descuadrado ("El asiento no está
  balanceado") por dos fallos de signo relacionados: (1) las líneas
  por código de pago siempre se ponían en el Debe, sin mirar si el
  neto de ese código ese día era en realidad un reembolso (debería ir
  al Haber); (2) el criterio de rectificativa estaba copiado de Fase 1
  sin ajustar el signo — en las líneas `Payment` (a diferencia de las
  `Revenue`), una rectificativa suma en POSITIVO, no en negativo
  (confirmado con el ejemplo real RPHF000054: Revenue -295,3€, Payment
  +295,3€). Con los dos corregidos, el cuadre es exacto matemáticamente
  para cualquier mezcla de cobros y reembolsos ese día, no solo para
  el caso sin reembolsos.

## ⚠️ Aviso importante: posible desplazamiento de un día en fechas ya creadas

`formatFechaOdoo()` usaba `.toISOString()` (siempre UTC) para las
fechas de factura de Fase 1 y de agrupación de Fase 4. Si Sheets
convirtió una celda de texto ISO a tipo Fecha (algo que hace solo,
sin avisar), el `Date` resultante representa medianoche en Madrid —
y `.toISOString()` lo pasaba a UTC, perdiendo un día (medianoche CEST
= 22:00 del día anterior en UTC). Ya está arreglado con
`Utilities.formatDate(..., 'Europe/Madrid', ...)`.

**Esto pudo haber afectado a facturas de Fase 1 ya creadas en Odoo
antes de este fix**, con `invoice_date` un día antes del real — vale
la pena revisar alguna factura de las primeras pruebas y comprobar la
fecha contra el `Closed` real del JSON, por si hace falta corregir
alguna a mano.

## Panel de control (Web App)

Interfaz web propia dentro del mismo proyecto de Apps Script — no es
código nuevo de negocio, es una capa fina (`12_PanelWeb.gs` +
`Panel.html`) sobre las mismas funciones `*Core` que ya usa el menú.
Pensado para gente no técnica del equipo, uso diario.

### Cómo funciona

- `12_PanelWeb.gs` añade `doGet(e)` (sirve el HTML) y unas funciones
  `panelXxx()` que llaman a las mismas `*Core` de siempre y devuelven
  objetos planos — nunca objetos de Drive/Sheets, porque
  `google.script.run` (el puente entre el HTML y Apps Script) no
  puede serializarlos.
- `Panel.html` es la interfaz: un semáforo de estado por fase y un
  botón por acción. Llama a las funciones `panelXxx()` vía
  `google.script.run` y pinta el resultado, sin usar ningún
  `ui.alert()` (por eso hicieron falta las versiones `*Core` de cada
  función — `ui.alert()` revienta si no hay una hoja abierta detrás,
  como ya vimos con el disparador automático de Huéspedes).

### Desplegar

Extensiones → Apps Script → pega `12_PanelWeb.gs` y crea un archivo
HTML nuevo llamado exactamente **`Panel`** (Archivo → Nuevo → Html,
Apps Script le añade `.html` solo) con el contenido de `Panel.html`.

Implementar → Nueva implementación → Aplicación web → ejecutar como
tú, acceso a quien vaya a usarlo (tu dominio de Google Workspace, o
"Cualquier usuario con cuenta de Google" si hace falta). Copia la
URL — esa es la del panel.

Puedes reusar el mismo proyecto que ya tiene el webhook (`doPost`) —
Apps Script distingue solas las peticiones por verbo HTTP (GET =
panel, POST = webhook de Mews), así que no hay conflicto. Si
prefieres URLs separadas para no mezclar "la URL que le doy a Mews"
con "la URL que uso yo", crea una implementación nueva del mismo
proyecto — cada implementación tiene su propia URL aunque compartan
código.

### Qué NO hace (a propósito, de momento)

No reemplaza los pasos manuales en Odoo (confirmar facturas, revisar
discrepancias grandes) — sigue siendo "aprieta el botón, luego ve a
Odoo a confirmar". Tampoco bloquea físicamente que se salte el orden
de las fases (los botones no se deshabilitan según el estado) —
solo informa con el semáforo. Si con el uso real se ve que hace falta
más guía o bloqueo, es una mejora para después, no para hoy.

## Novedades para propiedades con peso de agencias/touroperadores

Pensado para propiedades donde muchas reservas llegan a través de
agencias (On the Beach, Jet2holidays, WebBeds...), confirmado con
datos reales de una segunda propiedad del grupo:

- **`associated_profile`**: nueva columna en `FACTURAS` (al final, no
  rompe nada de lo existente). Captura el campo `Associated profile`
  de Mews — el nombre real de la agencia (ej. "On the Beach Beds
  Ltd"), cuando `Associated tax ID` es el NIF de una agencia en vez
  del huésped. Se usa como nombre preferido al crear el cliente en
  Odoo, en vez del genérico "Empresa <CIF>". Si usas el sistema con
  una hoja ya creada, añade esta columna al final de `FACTURAS`.

- **`UMBRAL_SOLO_SIN_NIF`** (CONFIG, opcional, `true`/`false`): por
  defecto el umbral de creación de cliente aplica siempre que haga
  falta crear uno nuevo, tenga NIF o no. Si lo pones a `true`, el
  umbral deja de aplicar cuando hay un NIF/CIF REAL de Mews (no uno
  sacado de pasaporte) — el cliente se crea siempre que haya NIF real,
  sin importar el importe. Pensado para cuando el NIF suele ser el de
  una agencia con la que hay relación recurrente, no algo puntual que
  deba esperar a superar un importe.

## Códigos de pago a diferir (ej. INV) — pendiente de Fase 5

Para propiedades donde un código de pago (ej. `INV`) no siempre
significa un cobro real — a veces es "facturado a agencia, aún sin
pagar", y otras veces (reservas directas, sin agencia asociada) es
"se está consumiendo un anticipo ya cobrado en Fase 2" — Fase 4 no
intenta adivinar cuál es cuál. Se excluyen del todo con:

```
FASE4_CODIGOS_DIFERIR    INV
```

Los pagos con esos códigos quedan marcados en `PAGOS_CLOSED` como
`PENDIENTE_FASE5` (con nota), sin bloquear el resto del día. El
consumo de anticipos contra la 438100 (o la cuenta que corresponda)
es una pieza nueva de verdad — cruzar la factura contra un saldo
YA EXISTENTE de Fase 2, no contra un cobro nuevo — pensada como su
propia fase futura, no un parche dentro de Fase 4.

## Procesar Reservations desde Drive (para webhooks standalone propios)

Si en vez del `doPost` único del proyecto (que procesa Reservations
al vuelo) usas tu propio webhook standalone que guarda el JSON de
Reservations en Drive, `05_Reservas.gs` ahora también sabe leer esos
archivos pendientes y volcarlos a `RESERVAS` — reutiliza la misma
`upsertReservas()` de siempre, no duplica lógica de parseo.

Detecta los archivos por nombre (busca "RESERVATIONS" en mayúsculas
en el nombre del archivo) dentro de `FOLDER_ID_INBOX` — la misma
carpeta que usan Closed/Payment, no hace falta una carpeta aparte.

Menú → "🗺️ Cargar reservas de Mews" (o el botón equivalente del panel
web). Conviene procesarlas **antes** de cargar facturas, para que el
localizador de la OTA esté disponible en cuanto se creen.

- `extraerPagosParaFase4()` tenía el mismo bug de fecha que ya
  arreglamos en Fase 4: al leer `fecha_cierre` de vuelta de
  `PAGOS_CLOSED` para comprobar duplicados, si Sheets había
  convertido esa celda a tipo Fecha, la comparación de texto nunca
  coincidía — así que CADA vez que se reprocesaba el mismo archivo,
  todas sus líneas de pago se volvían a insertar como si fueran
  nuevas. Ahora se normaliza con `formatFechaOdoo()` al leer, igual
  que en Fase 4.

## Separador entre serie y número (opcional, por propiedad)

Mews no es consistente en el formato del `Bill` incluso dentro de la
misma propiedad — a veces viene pegado (`HIR2086994`, se convierte
solo a `HIR/2086994`) y a veces con espacio (`HIR 2086997`, se queda
tal cual, sin barra). Para propiedades donde quieres el separador
SIEMPRE, sin depender de cómo venga el texto de Mews:

```
SEPARADOR_NUM_FACTURA    /
```

Con esto puesto, el nombre de la factura en Odoo siempre se construye
como `<serie><separador><número>` (ej. `HIR/2086994`), ignorando el
formato original. Sin esta clave en CONFIG (como en Pikes), el
comportamiento no cambia — sigue tal cual venía de Mews.


## Decisión revertida: NO usar el CIF de la agencia de la reserva como respaldo

Se probó (y se revirtió) rellenar `cliente_nif` con el CIF extraído
de `agencia` (Reservations → "Travel agency") cuando el Closed venía
vacío. Se revirtió porque es **incorrecto**: que una reserva entera
sea de una agencia no significa que todos sus bills se facturen a esa
agencia — ej. la Ecotasa (`Code: ECO`) la paga el huésped directamente
aunque la estancia se facture a Jet2holidays. El `Associated tax ID`
vacío en un bill concreto del Closed es la fuente de verdad correcta
para "quién paga ESTE bill" — no hay que rellenarlo desde el nivel de
reserva.

## Fase 5 — Consumo de anticipos (solo Ibiza Rocks Direct, nuevo)

Mismo circuito contable que Fase 4 (Debe cuenta puente, Haber 430,
conciliar la factura) — la diferencia es que aquí no es dinero nuevo,
es consumir un anticipo ya cobrado antes (vía Fase 2, código
`ANTICIPOMEWS`) contra el saldo de la cuenta. Mews no vincula qué
anticipo concreto corresponde a qué factura — se concilia directo
contra el saldo, sin buscar coincidencia por cliente ni reserva.

Solo actúa sobre los pagos `INV` de bills **sin agencia** (`cliente_nif`
vacío en FACTURAS) — reservas directas de Ibiza Rocks Direct. Los
`INV` de bills **con** agencia se dejan tal cual en `PENDIENTE_FASE5`
— siguen significando "facturado a la agencia, aún sin pagar de
verdad", no hay que tocarlos aquí.

Puede ser consumo total o parcial de lo pendiente de la factura (Mews
mete en INV "lo que quede" tras otros pagos, no siempre coincide con
el total completo).

CONFIG necesario (nuevo):
```
FASE5_CUENTA_ANTICIPO   <cuenta puente 438 contra la que se consume>
```
Reutiliza `FASE4_CUENTA_430`, `FASE4_JOURNAL_ID` y `ODOO_COMPANY_ID`
— no hace falta configurarlos de nuevo.

**Importante — orden de ejecución**: Fase 4 del mismo día tiene que
correr ANTES que Fase 5, porque Fase 5 comprueba el importe pendiente
(`amount_residual`) de la factura DESPUÉS de lo que Fase 4 ya haya
conciliado. Si Fase 5 va primero, el residual todavía incluye pagos
que Fase 4 no ha aplicado todavía.

Idempotencia: `ref = MEWS-COB5/<fecha>`, mismo criterio que Fase 2/4.

Menú → "🏦 Consumir anticipos (Fase 5)".

## Corrección en Fase 5: criterio de "Ibiza Rocks Direct"

El criterio real para Fase 5 NO es "bill sin agencia" (`cliente_nif`
vacío) — eso también capturaría otros casos sin relación (ej.
Ecotasas sueltas con `Associated profile` vacío). El criterio correcto
es: la columna `agencia` de FACTURAS (viene de RESERVAS/Reservations)
coincide exactamente con la agencia directa configurada. Nueva clave:

```
FASE5_NOMBRE_AGENCIA_DIRECTA   Ibiza Rocks Direct
```
