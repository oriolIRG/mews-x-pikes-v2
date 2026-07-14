/**
 * ================================================================
 *  RESERVAS — recibe reservas de Mews para poder mostrar el
 *  localizador de la OTA (Booking, Expedia...) en cada factura.
 * ================================================================
 *  El enrutado (detectar que es un JSON de Reservations y llamar a
 *  upsertReservas) pasa por el doPost(e) único de 04_Webhooks.gs,
 *  no hay un endpoint propio aquí.
 * ================================================================
 */

function upsertReservas(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let wsRes = ss.getSheetByName(TAB.RESERVAS);

  if (!wsRes) {
    wsRes = ss.insertSheet(TAB.RESERVAS);
    wsRes.getRange(1, 1, 1, 4).setValues([
      ['reservation_number', 'localizador_ota', 'agencia', 'ultima_actualizacion']
    ]);
    wsRes.getRange(1, 1, 1, 4).setFontWeight('bold');
    wsRes.setFrozenRows(1);
  }

  const existing = wsRes.getDataRange().getValues();
  const cacheMap = {};
  for (let i = 1; i < existing.length; i++) {
    const num = String(existing[i][0]).trim();
    if (num) cacheMap[num] = i + 1;
  }

  let empresa = '';
  let reservas = [];

  for (const doc of data.Documents) {
    if (doc.Name === 'Parameters') {
      for (const row of doc.Data) {
        if (Array.isArray(row) && row[0] === 'Enterprise') empresa = row[1] || '';
      }
    }
    if (doc.Name === 'Reservations' && Array.isArray(doc.Data) && doc.Data.length > 1) {
      const headers = doc.Data[0];
      const idxNum = headers.indexOf('Number');
      const idxLoc = headers.indexOf('Travel agency confirmation number');
      const idxAg = headers.indexOf('Travel agency');

      for (let i = 1; i < doc.Data.length; i++) {
        const row = doc.Data[i];
        const num = String(row[idxNum] || '').trim();
        if (!num) continue;
        reservas.push({
          num,
          loc: String(row[idxLoc] || '').trim(),
          ag: String(row[idxAg] || '').trim(),
        });
      }
    }
  }

  const ahoraTs = new Date().toISOString();
  let nuevas = 0;
  let actualizadas = 0;
  const toInsert = [];

  for (const r of reservas) {
    if (cacheMap[r.num]) {
      const rowIdx = cacheMap[r.num];
      const oldLoc = String(existing[rowIdx - 1][1] || '').trim();
      const oldAg = String(existing[rowIdx - 1][2] || '').trim();
      if (oldLoc !== r.loc || oldAg !== r.ag) {
        wsRes.getRange(rowIdx, 2, 1, 3).setValues([[r.loc, r.ag, ahoraTs]]);
        actualizadas++;
      }
    } else {
      toInsert.push([r.num, r.loc, r.ag, ahoraTs]);
      cacheMap[r.num] = -1;
      nuevas++;
    }
  }

  if (toInsert.length > 0) {
    wsRes.getRange(wsRes.getLastRow() + 1, 1, toInsert.length, 4).setValues(toInsert);
  }

  return { empresa, total: reservas.length, nuevas, actualizadas };
}

function buscarLocalizador(reservationNum) {
  if (!reservationNum) return { localizador: '', agencia: '' };

  const wsRes = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB.RESERVAS);
  if (!wsRes || wsRes.getLastRow() < 2) return { localizador: '', agencia: '' };

  const data = wsRes.getDataRange().getValues();
  const numStr = String(reservationNum).trim();

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === numStr) {
      return {
        localizador: String(data[i][1] || '').trim(),
        agencia: String(data[i][2] || '').trim(),
      };
    }
  }
  return { localizador: '', agencia: '' };
}
