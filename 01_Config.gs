/**
 * ================================================================
 *  CONFIG — lectura de la pestaña CONFIG y sus mapeos
 * ================================================================
 *  La pestaña CONFIG tiene 2 columnas: clave | valor.
 *  Claves con prefijo tienen significado especial:
 *    VAT_<tipo>    → id del impuesto en Odoo para ese % de IVA
 *    SERIE_<serie> → id del diario en Odoo para esa serie de factura
 *    PROD_<code>   → id del producto en Odoo para ese código de Mews
 *    DESC_<code>   → descripción legible para ese código de Mews
 *      (si no hay DESC_ para un código, se usa el código tal cual)
 *
 *  CONFIG MÍNIMO para arrancar (rellenar en la hoja nueva):
 *    odoo_url              → https://tuservidor.odoo.com
 *    odoo_db               → nombre de la base de datos
 *    odoo_user             → usuario técnico de Odoo
 *    partner_varios_id     → id del partner "Clientes Varios" en Odoo
 *    FOLDER_ID_INBOX       → carpeta Drive donde llegan los JSONs
 *    FOLDER_ID_PROCESADOS  → carpeta Drive donde se archivan tras procesar
 *  (La API Key de Odoo NO va en CONFIG: se guarda en
 *   Apps Script → Configuración del proyecto → Propiedades del script
 *   → clave ODOO_API_KEY)
 *
 *  Los VAT_/SERIE_/PROD_/DESC_ se van añadiendo poco a poco, a medida
 *  que aparecen códigos nuevos al reprocesar julio. No hace falta
 *  rellenarlo todo el primer día.
 * ================================================================
 */

function getConfig() {
  const ws = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB.CONFIG);
  if (!ws) throw new Error(`Falta la pestaña "${TAB.CONFIG}" en esta hoja.`);
  const data = ws.getDataRange().getValues();
  const cfg = {};
  for (const row of data) {
    const key = String(row[0] || '').trim();
    const val = String(row[1] || '').trim();
    if (key && !key.startsWith('#') && !key.startsWith('⚙') && val) {
      cfg[key] = val;
    }
  }
  return cfg;
}

function getMappings(cfg) {
  const vat = {};
  const series = {};
  const productos = {};
  const descripciones = {};

  for (const [key, val] of Object.entries(cfg)) {
    if (key.startsWith('VAT_'))   vat[key.replace('VAT_', '')] = parseInt(val);
    if (key.startsWith('SERIE_')) series[key.replace('SERIE_', '')] = parseInt(val);
    if (key.startsWith('PROD_'))  productos[key.replace('PROD_', '')] = parseInt(val);
    if (key.startsWith('DESC_'))  descripciones[key.replace('DESC_', '')] = val;
  }

  return { vat, series, productos, descripciones };
}

function getApiKey() {
  const key = PropertiesService.getScriptProperties().getProperty('ODOO_API_KEY');
  if (!key) {
    throw new Error(
      'API Key no configurada. Apps Script → Configuración del proyecto → ' +
      'Propiedades de script → añade ODOO_API_KEY'
    );
  }
  return key;
}

// Única función de verificación de CONFIG en todo el proyecto
// (en el repo viejo esta función estaba duplicada dos veces en el
// mismo archivo — aquí solo existe una vez, a propósito).
function verificarConfig() {
  const cfg = getConfig();
  const required = ['odoo_url', 'odoo_db', 'odoo_user', 'partner_varios_id', 'FOLDER_ID_INBOX', 'ODOO_COMPANY_ID', 'FISCAL_POSITION_ID'];
  const missing = required.filter(k => !cfg[k] || cfg[k] === 'RELLENAR');

  const apiKey = PropertiesService.getScriptProperties().getProperty('ODOO_API_KEY');
  if (!apiKey) missing.push('ODOO_API_KEY (Propiedades del proyecto, no en CONFIG)');

  if (missing.length > 0) {
    SpreadsheetApp.getUi().alert('❌ Faltan estos valores:\n• ' + missing.join('\n• '));
  } else {
    SpreadsheetApp.getUi().alert('✅ CONFIG completa y API Key presente. Prueba la conexión a Odoo.');
  }
}
