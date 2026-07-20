/**
 * ================================================================
 *  UTILS — helpers genéricos sin lógica de negocio
 * ================================================================
 */

function ahora() {
  return new Date().toISOString();
}

function formatFechaOdoo(dt) {
  // Europe/Madrid explícito, NUNCA .toISOString() (siempre UTC). Si
  // Sheets convirtió una celda de texto ISO a tipo Fecha, el Date que
  // devuelve representa medianoche en Madrid — con .toISOString() eso
  // se convertía a UTC y se perdía un día (medianoche CEST = 22:00 del
  // día anterior en UTC). Con formatDate() y zona explícita, se
  // interpreta bien tanto si llega texto como si llega ese Date.
  if (!dt) return Utilities.formatDate(new Date(), 'Europe/Madrid', 'yyyy-MM-dd');
  const d = new Date(dt);
  if (isNaN(d.getTime())) return Utilities.formatDate(new Date(), 'Europe/Madrid', 'yyyy-MM-dd');
  return Utilities.formatDate(d, 'Europe/Madrid', 'yyyy-MM-dd');
}

function md5(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, text, Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 0xFF).toString(16)).slice(-2))
    .join('');
}

function getValoresExistentes(ws, colName, headers) {
  const set = new Set();
  const data = ws.getDataRange().getValues();
  if (data.length < 2) return set;
  const idx = headers.indexOf(colName);
  if (idx < 0) return set;
  for (let i = 1; i < data.length; i++) {
    if (data[i][idx]) set.add(String(data[i][idx]));
  }
  return set;
}

function appendRows(ws, rows) {
  if (!rows || rows.length === 0) return;
  ws.getRange(ws.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

function actualizarFila(ws, rowNum, headers, updates) {
  for (const [key, val] of Object.entries(updates)) {
    const col = headers.indexOf(key);
    if (col >= 0) ws.getRange(rowNum, col + 1).setValue(val);
  }
}

function extraerItems(data) {
  for (const doc of data.Documents) {
    if (doc.Name === 'Items' && Array.isArray(doc.Data) && doc.Data.length > 1) {
      const headers = doc.Data[0];
      return doc.Data.slice(1).map(row => {
        const obj = {};
        headers.forEach((h, i) => { obj[h] = row[i]; });
        return obj;
      });
    }
  }
  return [];
}

function cargarLineas(wsLin) {
  const data = wsLin.getDataRange().getValues();
  if (data.length < 2) return {};
  const result = {};
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const bill = String(row[0]).trim();
    if (!bill) continue;
    if (!result[bill]) result[bill] = [];
    result[bill].push({
      linea_num: row[1],
      mews_code: row[2],
      descripcion: row[3],
      vat_rate: row[4],
      net: parseFloat(row[5]) || 0,
      vat_amount: parseFloat(row[6]) || 0,
      amount_bruto: parseFloat(row[7]) || 0,
      odoo_product_id: row[8] ? parseInt(row[8]) : false,
      odoo_tax_id: row[9] ? parseInt(row[9]) : false,
    });
  }
  return result;
}

function registrarLog(tipo, empresa, numItems, hash, estado, notas) {
  const ws = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB.LOG);
  if (!ws) return; // no bloquea el flujo si aún no existe la pestaña
  ws.appendRow([ahora(), tipo, empresa, numItems, hash, estado, notas || '']);
}

function hashYaProcesado(hash) {
  const ws = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB.LOG);
  if (!ws) return false;
  const data = ws.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][4] === hash && data[i][5] !== 'IGNORADO') return true;
  }
  return false;
}

// Respuesta JSON estándar para los webhooks.
// (En el repo viejo esta función se llamaba desde 4 sitios distintos
// pero nunca estaba definida — cualquier webhook fallaba en runtime.
// Aquí sí existe.)
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
