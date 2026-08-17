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
 *   AUDITORIA_MEWS_FOLDER_ID              -> ID de la carpeta de Drive donde depositas los xlsx mensuales
 *   AUDITORIA_MEWS_SHEET                  -> (opcional) nombre de la pestaña destino, por defecto 'AUDITORIA_MEWS'
 *   AUDITORIA_MEWS_FOLDER_PROCESADOS_ID   -> (opcional) ID de carpeta donde mover cada xlsx tras procesarlo con éxito.
 *                                             Si se deja vacía, los ficheros no se mueven (se reprocesan cada vez).
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
  var procesadosFolderId = cfg['AUDITORIA_MEWS_FOLDER_PROCESADOS_ID'] || '';

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
  var now = new Date();
  var ficherosOmitidos = [];
  var ficherosMovidos = [];

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
      var counterColIdx = fileHeaders.indexOf('Counter');

      for (var r = 1; r < values.length; r++) {
        var row = values[r];
        // Saltar filas totalmente vacías
        var vacia = true;
        for (var c = 0; c < row.length; c++) {
          if (row[c] !== '' && row[c] !== null) { vacia = false; break; }
        }
        if (vacia) continue;

        var receiptVal = receiptColIdx >= 0 ? row[receiptColIdx] : '';
        var counterVal = counterColIdx >= 0 ? row[counterColIdx] : '';
        var serieNorm = normalizarSerieMews_(receiptVal);
        var serieOdoo = extraerPrefijoCounter_(counterVal);
        var numeroOdoo = extraerNumeroReceipt_(receiptVal);

        // Mapear la fila a la cabecera maestra
        var mapped = new Array(masterHeaders.length).fill('');
        fileHeaders.forEach(function (h, idx) {
          if (h) mapped[headerIndex[h]] = row[idx];
        });

        allRows.push({
          serieNorm: serieNorm,
          serieOriginal: receiptVal,
          serieOdoo: serieOdoo,
          numeroOdoo: numeroOdoo,
          archivoOrigen: fileName,
          mapped: mapped
        });
      }

      // Si ha llegado hasta aquí sin excepción, el fichero se ha procesado con éxito.
      if (procesadosFolderId) {
        moverFicheroAProcesados_(file, procesadosFolderId);
        ficherosMovidos.push(fileName);
      }
    } catch (e) {
      Logger.log('ERROR procesando ' + fileName + ': ' + (e && e.stack ? e.stack : e));
      ficherosOmitidos.push(fileName + ' -> ' + e);
    } finally {
      if (tmpSpreadsheetId) {
        try { DriveApp.getFileById(tmpSpreadsheetId).setTrashed(true); } catch (e2) {}
      }
    }
  });

  // Construir cabecera final de salida (de los ficheros procesados en ESTA ejecución)
  var nuevoHeader = ['SERIE_NORM', 'SERIE_MEWS', 'SERIE_ODOO', 'NUMERO_ODOO', 'DUPLICADO', 'ARCHIVO_ORIGEN', 'FECHA_CONSOLIDACION'].concat(masterHeaders);

  var nuevasFilas = allRows.map(function (item) {
    return [item.serieNorm, item.serieOriginal, item.serieOdoo, item.numeroOdoo, '', item.archivoOrigen, now].concat(item.mapped);
    // DUPLICADO (índice 4) se recalcula más abajo sobre el conjunto final
  });

  var modoAcumulativo = !!procesadosFolderId;
  var outHeader, outRows;

  if (modoAcumulativo) {
    var existente = leerHojaExistente_(ss, sheetName);
    var combinado = combinarConExistente_(existente, nuevoHeader, nuevasFilas);
    outHeader = combinado.header;
    outRows = combinado.rows;
  } else {
    outHeader = nuevoHeader;
    outRows = nuevasFilas;
    recalcularDuplicados_(outHeader, outRows);
  }

  escribirHojaAuditoriaMews_(ss, sheetName, outHeader, outRows);

  var nDup = 0;
  var dupIdx = outHeader.indexOf('DUPLICADO');
  outRows.forEach(function (r) { if (r[dupIdx] === 'SI') nDup++; });

  var msg = 'Consolidación completada (' + (modoAcumulativo ? 'modo acumulativo' : 'modo borrón y cuenta nueva') + ').\n' +
    'Ficheros procesados en esta ejecución: ' + files.length + '\n' +
    'Filas nuevas añadidas: ' + nuevasFilas.length + '\n' +
    'Filas totales en la pestaña: ' + outRows.length + '\n' +
    'Filas marcadas como DUPLICADO: ' + nDup;
  if (ficherosMovidos.length > 0) {
    msg += '\n\nMovidos a procesados:\n' + ficherosMovidos.join('\n');
  }
  if (ficherosOmitidos.length > 0) {
    msg += '\n\nFicheros omitidos (se quedan en la carpeta para reintentar):\n' + ficherosOmitidos.join('\n');
  }
  SpreadsheetApp.getUi().alert(msg);
}

/**
 * Lee la pestaña AUDITORIA_MEWS tal como está antes de esta ejecución.
 * Devuelve null si la pestaña no existe o está vacía (primera ejecución).
 */
function leerHojaExistente_(ss, sheetName) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return null;
  var values = sheet.getDataRange().getValues();
  if (values.length < 1) return null;
  var header = values[0];
  var rows = values.slice(1).filter(function (row) {
    return row.some(function (c) { return c !== '' && c !== null; });
  });
  return { header: header, rows: rows };
}

/**
 * Combina las filas ya existentes en la hoja con las filas nuevas de esta ejecución.
 * Si el conjunto de columnas ha cambiado (Mews añade una categoría nueva, etc.), amplía
 * la cabecera combinada y rellena con '' donde una fila antigua no tenía esa columna.
 * Recalcula DUPLICADO sobre el conjunto combinado completo.
 */
function combinarConExistente_(existente, nuevoHeader, nuevasFilas) {
  if (!existente) {
    var header = nuevoHeader;
    var rows = nuevasFilas;
    recalcularDuplicados_(header, rows);
    return { header: header, rows: rows };
  }

  // Cabecera combinada: la existente primero, más cualquier columna nueva no vista antes
  var combinedHeader = existente.header.slice();
  nuevoHeader.forEach(function (h) {
    if (combinedHeader.indexOf(h) === -1) combinedHeader.push(h);
  });

  var remap = function (rows, fromHeader) {
    return rows.map(function (row) {
      var out = new Array(combinedHeader.length).fill('');
      fromHeader.forEach(function (h, idx) {
        var pos = combinedHeader.indexOf(h);
        if (pos !== -1) out[pos] = row[idx];
      });
      return out;
    });
  };

  var filasExistentesRemapeadas = remap(existente.rows, existente.header);
  var filasNuevasRemapeadas = remap(nuevasFilas, nuevoHeader);

  var combinedRows = filasExistentesRemapeadas.concat(filasNuevasRemapeadas);
  recalcularDuplicados_(combinedHeader, combinedRows);

  return { header: combinedHeader, rows: combinedRows };
}

/**
 * Recalcula la columna DUPLICADO in-place: 'SI' si la misma SERIE_NORM aparece
 * en más de un ARCHIVO_ORIGEN distinto dentro del conjunto de filas dado.
 */
function recalcularDuplicados_(header, rows) {
  var serieIdx = header.indexOf('SERIE_NORM');
  var archivoIdx = header.indexOf('ARCHIVO_ORIGEN');
  var dupIdx = header.indexOf('DUPLICADO');
  if (serieIdx === -1 || archivoIdx === -1 || dupIdx === -1) return;

  var conteo = {};
  rows.forEach(function (row) {
    var serie = row[serieIdx];
    if (!serie) return;
    conteo[serie] = conteo[serie] || {};
    conteo[serie][row[archivoIdx]] = true;
  });

  rows.forEach(function (row) {
    var serie = row[serieIdx];
    var nFicheros = serie ? Object.keys(conteo[serie] || {}).length : 1;
    row[dupIdx] = nFicheros > 1 ? 'SI' : 'NO';
  });
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
 * Extrae el prefijo de la columna Counter de Mews, p.ej. "PHF - Hotel invoices" -> "PHF",
 * "HPI - Tests / Cross-settlements" -> "HPI", "RPHF Credit notes" -> "RPHF" (sin " - ",
 * se coge la primera palabra).
 */
function extraerPrefijoCounter_(valor) {
  if (valor === null || valor === undefined || valor === '') return '';
  var texto = valor.toString().trim();
  var prefijo;
  if (texto.indexOf(' - ') !== -1) {
    prefijo = texto.split(' - ')[0];
  } else {
    prefijo = texto.split(/\s+/)[0];
  }
  return prefijo.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Extrae el número final de la columna Receipt de Mews, p.ej. "PHF 2000766" -> "2000766",
 * "Tests / Cross-settlements counter 2000085" -> "2000085".
 */
function extraerNumeroReceipt_(valor) {
  if (valor === null || valor === undefined) return '';
  var m = valor.toString().trim().match(/(\d+)\s*$/);
  return m ? m[1] : '';
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
 * Convierte un fichero .xlsx de Drive a una Google Sheet temporal (usando Advanced Drive Service).
 * NOTA: el Advanced Drive Service usa la API v3 por defecto, donde el campo es "name"
 * (no "title", que era de la v2) y no existe el parámetro "convert": basta con pedir
 * como mimeType de destino un Google Sheet para que Drive convierta el .xlsx al copiarlo.
 * Devuelve el ID de la copia temporal. El llamante es responsable de borrarla.
 */
function convertirXlsxATemporalSheet_(file) {
  var resource = {
    name: 'TMP_AUDITORIA_' + file.getName() + '_' + new Date().getTime(),
    mimeType: MimeType.GOOGLE_SHEETS
  };
  var converted = Drive.Files.copy(resource, file.getId(), { supportsAllDrives: true });
  return converted.id;
}

/**
 * Mueve un fichero a la carpeta de procesados (lo añade allí y lo quita de sus carpetas
 * padre originales). Usa DriveApp, que soporta Unidades compartidas de forma transparente.
 */
function moverFicheroAProcesados_(file, procesadosFolderId) {
  var destino = DriveApp.getFolderById(procesadosFolderId);
  destino.addFile(file);
  var parents = file.getParents();
  while (parents.hasNext()) {
    var p = parents.next();
    if (p.getId() !== procesadosFolderId) {
      p.removeFile(file);
    }
  }
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

// Descomenta solo si NO tienes ya un onOpen() en otro fichero del proyecto:
// function onOpen() {
//   var ui = SpreadsheetApp.getUi();
//   var menu = ui.createMenu('Auditoría');
//   addAuditoriaMewsMenuItem_(menu);
//   menu.addToUi();
// }