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
FOLDER_ID_INBOX         <id carpeta Drive de entrada>
FOLDER_ID_PROCESADOS    <id carpeta Drive de archivo>
```

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
