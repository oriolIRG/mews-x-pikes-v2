/**
 * ================================================================
 *  WEBHOOKS — 3 endpoints separados para MEWS
 * ================================================================
 *  Deployment 1 → doPostClosed()   → URL para Accounting Closed
 *  Deployment 2 → doPostCreated()  → URL para Accounting Created
 *  Deployment 3 → doPostPayment()  → URL para Payment Report
 *  (Reservations comparte lógica pero se procesa aparte, ver abajo)
 *
 *  Cada webhook guarda el JSON en Drive (carpeta FOLDER_ID_INBOX en
 *  CONFIG) y responde inmediatamente. El procesamiento real se hace
 *  desde el menú de Sheets cuando el operador lo decide.
 * ================================================================
 */

function doPostClosed(e) {
  return recibirJsonDeMews(e, 'CLOSED');
}

function doPostCreated(e) {
  return recibirJsonDeMews(e, 'CREATED');
}

function doPostPayment(e) {
  return recibirJsonDeMews(e, 'PAYMENT');
}

function doPost(e) {
  // Fallback genérico si se usa una única URL para todo.
  return recibirJsonDeMews(e, 'UNKNOWN');
}

function recibirJsonDeMews(e, tipoEsperado) {
  try {
    const raw = e.postData.contents;
    const hash = md5(raw);

    if (hashYaProcesado(hash)) {
      return jsonResponse({ status: 'duplicate', hash });
    }

    const cfg = getConfig();
    const folderId = cfg['FOLDER_ID_INBOX'];
    if (!folderId) throw new Error('FOLDER_ID_INBOX no configurado en CONFIG');

    const folder = DriveApp.getFolderById(folderId);
    const timestamp = Utilities.formatDate(new Date(), 'Europe/Madrid', 'yyyy-MM-dd_HH-mm-ss');
    const filename = `MEWS_${tipoEsperado}_${timestamp}.json`;

    folder.createFile(filename, raw, MimeType.PLAIN_TEXT);

    registrarLog('WEBHOOK_' + tipoEsperado, '', 0, hash, 'GUARDADO_DRIVE', filename);

    return jsonResponse({ status: 'ok', tipo: tipoEsperado, file: filename });

  } catch (err) {
    Logger.log('ERROR webhook ' + tipoEsperado + ': ' + err.message);
    return jsonResponse({ status: 'error', message: err.message });
  }
}

function detectarTipoReporte(data) {
  const params = data.Documents[0].Data;
  let empresa = '';
  let tipoParam = '';
  let titulo = '';
  let numItems = 0;

  for (const row of params) {
    if (!Array.isArray(row)) continue;
    if (row[0] === 'Enterprise') empresa = row[1];
    if (row[0] === 'Type') tipoParam = row[1];
    if (String(row[0]).includes('report')) titulo = String(row[0]);
  }

  for (const doc of data.Documents) {
    if (doc.Name === 'Items' && Array.isArray(doc.Data)) {
      numItems = Math.max(0, doc.Data.length - 1);
    }
  }

  let tipo;
  const tituloLow = titulo.toLowerCase();
  if (tipoParam === 'Closed' && (tituloLow.includes('accounting') || tituloLow.includes('order items'))) {
    tipo = 'ACCOUNTING_CLOSED';
  } else if (tipoParam === 'Created' && (tituloLow.includes('accounting') || tituloLow.includes('order items'))) {
    tipo = 'ACCOUNTING_CREATED';
  } else {
    tipo = 'PAYMENT_CREATED';
  }

  return { tipo, empresa, numItems };
}
