/**
 * 17_AuditoriaMews.gs
 * Consolida los informes mensuales "Bills and invoices" (.xlsx) exportados de Mews
 * en una única pestaña AUDITORIA_MEWS, para cruzarla luego con AUDITORIA_FACTURAS (Odoo).
 *
 * REQUIERE: Servicio avanzado "Drive API" activado en este proyecto de Apps Script
 * (Editor -> Servicios -> + -> Drive API -> Añadir). Necesario para convertir .xlsx a
 * Google Sheets al vuelo (Sheets no lee .xlsx nativamente).
 *
 * CONFIG (añadir estas claves a la pestaña CONFIG si no existen):
 *   AUDITORIA_MEWS_FOLDER_ID   -> ID de la carpeta de Drive donde depositas los xlsx mensuales
 *   AUDITORIA_MEWS_SHEET       -> (opcional) nombre de la pestaña destino, por defecto 'AUDITORIA_MEWS'
 */

var AUDITORIA_MEWS_SHEET_DEFAULT = 'AUDITORIA_MEWS';
var MEWS_FILE_TAB = 'File'; // nombre de la pestaña de datos dentro del xlsx de Mews

/**
 * Punto de entrada desde el menú.
 */
function consolidarAuditoriaMews() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cfg = leerConfigAuditoriaMews_();
  var folderId = cfg['AUDITORIA_MEWS_FOLDER_ID'];
  if (!folderId) {
    SpreadsheetApp.getUi().alert('Falta la clave AUDITORIA_MEWS_FOLDER_ID en la pestaña CONFIG (ID de la carpeta de Drive con los xlsx mensuales).');
    return;
  }
  var sheetName = cfg['AUDITORIA_MEWS_SHEET'] || AUDITORIA_MEWS_SHEET_DEFAULT;

  var folder = DriveApp.getFolderById(folderId);
  var files = getXlsxFilesInFolder_(folder);

  if (files.length === 0) {
    SpreadsheetApp.getUi().alert('No se han encontrado ficheros .xlsx en la carpeta configurada.');
    return;
  }

  Logger.log('Consolidando ' + files.length + ' ficheros...');

  var masterHeaders = [];       // union de cabeceras, en orden de aparición
  var headerIndex = {};         // header -> posición en masterHeaders
  var allRows = [];             // filas ya mapeadas a masterHeaders
  var serieCount = {};          // SERIE_NORM -> {ficheros: true} (para marcar duplicados)
  var now = new Date();
  var ficherosOmitidos = [];

  files.forEach(function (file) {
    var fileName = file.getName();
    var tmpSpreadsheetId = null;
    try {
      tmpSpreadsheetId = convertirXlsxATemporalSheet_(file);
      var tmpSs = SpreadsheetApp.openById(tmpSpreadsheetId);
      var dataSheet = tmpSs.getSheetByName(MEWS_FILE_TAB);
      if (!dataSheet) {
        Logger.log('AVISO: ' + fileName + ' no tiene pestaña "' + MEWS_FILE_TAB + '", se omite.');
        ficherosOmitidos.push(fileName);
        return;
      }
      var values = dataSheet.getDataRange().getValues();
      if (values.length < 2) return; // solo cabecera o vacío

      var fileHeaders = values[0].map(function (h) { return (h || '').toString().trim(); });

      // Registrar cabeceras nuevas en el maestro, preservando orden de aparición
      fileHeaders.forEach(function (h) {
        if (h && !(h in headerIndex)) {
          headerIndex[h] = masterHeaders.length;
          masterHeaders.push(h);
        }
      });

      var receiptColIdx = fileHeaders.indexOf('Receipt');

      for (var r = 1; r < values.length; r++) {
        var row = values[r];
        // Saltar filas totalmente vacías
        var vacia = true;
        for (var c = 0; c < row.length; c++) {
          if (row[c] !== '' && row[c] !== null) { vacia = false; break; }
        }
        if (vacia) continue;

        var receiptVal = receiptColIdx >= 0 ? row[receiptColIdx] : '';
        var serieNorm = normalizarSerieMews_(receiptVal);

        // Mapear la fila a la cabecera maestra
        var mapped = new Array(masterHeaders.length).fill('');
        fileHeaders.forEach(function (h, idx) {
          if (h) mapped[headerIndex[h]] = row[idx];
        });

        allRows.push({
          serieNorm: serieNorm,
          serieOriginal: receiptVal,
          archivoOrigen: fileName,
          mapped: mapped
        });

        if (serieNorm) {
          serieCount[serieNorm] = serieCount[serieNorm] || {};
          serieCount[serieNorm][fileName] = true;
        }
      }
    } catch (e) {
      Logger.log('ERROR procesando ' + fileName + ': ' + e);
      ficherosOmitidos.push(fileName + ' (error: ' + e + ')');
    } finally {
      if (tmpSpreadsheetId) {
        try { DriveApp.getFileById(tmpSpreadsheetId).setTrashed(true); } catch (e2) {}
      }
    }
  });

  // Construir cabecera final de salida
  var outHeader = ['SERIE_NORM', 'SERIE_MEWS', 'DUPLICADO', 'ARCHIVO_ORIGEN', 'FECHA_CONSOLIDACION'].concat(masterHeaders);

  var outRows = allRows.map(function (item) {
    var nFicheros = item.serieNorm ? Object.keys(serieCount[item.serieNorm] || {}).length : 1;
    var duplicado = nFicheros > 1 ? 'SI' : 'NO';
    return [item.serieNorm, item.serieOriginal, duplicado, item.archivoOrigen, now].concat(item.mapped);
  });

  escribirHojaAuditoriaMews_(ss, sheetName, outHeader, outRows);

  var nDup = 0;
  outRows.forEach(function (r) { if (r[2] === 'SI') nDup++; });

  var msg = 'Consolidación completada.\n' +
    'Ficheros procesados: ' + files.length + '\n' +
    'Filas totales: ' + outRows.length + '\n' +
    'Filas marcadas como DUPLICADO: ' + nDup;
  if (ficherosOmitidos.length > 0) {
    msg += '\n\nFicheros omitidos:\n' + ficherosOmitidos.join('\n');
  }
  SpreadsheetApp.getUi().alert(msg);
}

/**
 * Normaliza una clave de serie tipo "PHF 2001175", "PHF/2001175", "RPHF-2001175"
 * a un formato comparable independiente del separador: "PHF2001175".
 */
function normalizarSerieMews_(valor) {
  if (valor === null || valor === undefined) return '';
  return valor.toString().trim().toUpperCase().replace(/[\s\/\-_.]+/g, '');
}

/**
 * Devuelve todos los ficheros .xlsx de una carpeta (no entra en subcarpetas).
 */
function getXlsxFilesInFolder_(folder) {
  var out = [];
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    var name = f.getName();
    var mime = f.getMimeType();
    if (mime === MimeType.MICROSOFT_EXCEL || /\.xlsx$/i.test(name)) {
      out.push(f);
    }
  }
  return out;
}

/**
 * Convierte un fichero .xlsx de Drive a una Google Sheet temporal (usando Advanced Drive Service)
 * y devuelve el ID de la copia temporal. El llamante es responsable de borrarla.
 */
function convertirXlsxATemporalSheet_(file) {
  var resource = {
    title: 'TMP_AUDITORIA_' + file.getName() + '_' + new Date().getTime(),
    mimeType: MimeType.GOOGLE_SHEETS
  };
  var converted = Drive.Files.copy(resource, file.getId(), { convert: true });
  return converted.id;
}

/**
 * Lee la pestaña CONFIG del propio Spreadsheet activo (2 columnas: clave / valor).
 * Si ya tienes una función equivalente en tu proyecto (p.ej. getConfig()), sustituye
 * esta llamada por la tuya para no duplicar lógica.
 */
function leerConfigAuditoriaMews_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('CONFIG');
  var cfg = {};
  if (!sheet) return cfg;
  var values = sheet.getDataRange().getValues();
  values.forEach(function (row) {
    var key = (row[0] || '').toString().trim();
    if (key) cfg[key] = row[1];
  });
  return cfg;
}

/**
 * Limpia y escribe la pestaña AUDITORIA_MEWS con la cabecera y filas dadas.
 */
function escribirHojaAuditoriaMews_(ss, sheetName, header, rows) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  } else {
    sheet.clear();
  }
  sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, header.length).setValues(rows);
  }
  sheet.autoResizeColumns(1, header.length);
}

/**
 * Añade la entrada de menú. Llama a esta función desde tu onOpen() existente, por ejemplo:
 *   var menu = ui.createMenu('Auditoría');
 *   addAuditoriaMewsMenuItem_(menu);
 *   menu.addToUi();
 *
 * Si este fichero es el único que gestiona el menú, descomenta el onOpen de abajo.
 */
function addAuditoriaMewsMenuItem_(menu) {
  return menu.addItem('Consolidar Auditoría Mews', 'consolidarAuditoriaMews');
}

