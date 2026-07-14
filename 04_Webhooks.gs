/**
 * ================================================================
 *  WEBHOOKS — UN SOLO endpoint real para todo lo que envía Mews
 * ================================================================
 *  Importante sobre Apps Script: un despliegue como "Aplicación web"
 *  SIEMPRE ejecuta la función doPost(e) (ese nombre exacto), da igual
 *  cuántos despliegues distintos hagas. No existe la posibilidad de
 *  que un despliegue llame a una función con otro nombre directamente.
 *  (El repo original asumía lo contrario — doPostClosed/doPostCreated/
 *  doPostPayment como si cada uno fuera su propio endpoint — eso no
 *  funciona así en Apps Script real.)
 *
 *  Por eso aquí hay un único doPost(e) que MIRA EL CONTENIDO del JSON
 *  para decidir de qué tipo de reporte se trata, en vez de depender
 *  de qué "función" se supone que lo recibió.
 *
 *  DESPLIEGUE: Implementar → Nueva implementación → Aplicación web.
 *  Una sola URL. Esa misma URL se apunta en Mews para las 4
 *  suscripciones (Accounting Closed, Accounting Created, Payment
 *  Report, Reservations) — si Mews te permite usar la misma URL para
 *  varias suscripciones. Si Mews exige una URL distinta por
 *  suscripción, puedes desplegar varias veces (cada despliegue tiene
 *  su propia URL) — no pasa nada, todas ejecutan este mismo doPost(e)
 *  y detectan el tipo igual por contenido.
 * ================================================================
 */

function doPost(e) {
  // Candado: si llegan 2-3 llamadas casi a la vez (reintentos de Mews,
  // por ejemplo), sin esto todas podrían comprobar "¿ya existe?" antes
  // de que ninguna haya terminado de guardar, y guardarían todas el
  // mismo archivo por triplicado. Con el candado, solo una entra a la
  // vez; las demás esperan su turno.
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (lockErr) {
    return jsonResponse({ status: 'error', message: 'Ocupado, reintenta en unos segundos.' });
  }

  try {
    const raw = e.postData.contents;
    const hash = md5(raw);

    if (hashYaProcesado(hash)) {
      return jsonResponse({ status: 'duplicate', hash });
    }

    const data = JSON.parse(raw);
    const tipo = detectarTipoWebhook(data);

    // Reservations se procesa al vuelo (es rápido, no hace falta pasar por Drive)
    if (tipo === 'RESERVATIONS') {
      const result = upsertReservas(data);
      registrarLog('RESERVATIONS', result.empresa, result.total, hash, 'OK',
        `${result.nuevas} nuevas, ${result.actualizadas} actualizadas`);
      return jsonResponse({ status: 'ok', tipo, ...result });
    }

    // Accounting Closed / Created / Payment: se guardan en Drive y se
    // procesan más tarde desde el menú, cuando el operador lo decida.
    const cfg = getConfig();
    const folderId = cfg['FOLDER_ID_INBOX'];
    if (!folderId) throw new Error('FOLDER_ID_INBOX no configurado en CONFIG');

    const folder = DriveApp.getFolderById(folderId);
    const timestamp = Utilities.formatDate(new Date(), 'Europe/Madrid', 'yyyy-MM-dd_HH-mm-ss');
    const filename = `MEWS_${tipo}_${timestamp}.json`;

    folder.createFile(filename, raw, MimeType.PLAIN_TEXT);
    registrarLog('WEBHOOK_' + tipo, '', 0, hash, 'GUARDADO_DRIVE', filename);

    return jsonResponse({ status: 'ok', tipo, file: filename });

  } catch (err) {
    Logger.log('ERROR doPost: ' + err.message);
    return jsonResponse({ status: 'error', message: err.message });
  } finally {
    lock.releaseLock();
  }
}

// Distingue Reservations (estructura distinta, sin 'Items') del resto
// antes de delegar en detectarTipoReporte() para Closed/Created/Payment.
function detectarTipoWebhook(data) {
  if (data.Documents && data.Documents.some(doc => doc.Name === 'Reservations')) {
    return 'RESERVATIONS';
  }
  return detectarTipoReporte(data).tipo;
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
