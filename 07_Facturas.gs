/**
 * ================================================================
 *  FACTURAS — Accounting Closed de Mews → Odoo
 * ================================================================
 *  FLUJO:
 *   1. Mews envía el Closed report al webhook → se guarda en Drive
 *   2. Operador: menú "Procesar JSONs pendientes" → escribe en
 *      FACTURAS y FACTURAS_LINEAS (estado PENDIENTE)
 *   3. Operador revisa columna "continuidad" (huecos en numeración)
 *   4. Operador: menú "Enviar facturas a Odoo" → crea borradores
 *   5. Confirma manualmente en Odoo
 * ================================================================
 */

// ── 1. Parsear un Closed report ya cargado en memoria ─────────────
function parsearClosed(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const wsFact = ss.getSheetByName(TAB.FACTURAS);
  const wsLin = ss.getSheetByName(TAB.LINEAS);
  const cfg = getConfig();
  const mappings = getMappings(cfg);

  const items = extraerItems(data);

  const grupos = {};
  for (const item of items) {
    if (item['Type'] !== 'Revenue') continue;
    const bill = String(item['Bill'] || '').trim();
    if (!bill) continue;
    if (!grupos[bill]) grupos[bill] = [];
    grupos[bill].push(item);
  }

  const yaRegistradas = getValoresExistentes(wsFact, 'bill_mews', H_FACT);
  const yaRegistradasLineas = getValoresExistentes(wsLin, 'bill_mews', H_LIN);

  const nuevasFacturas = [];
  const nuevasLineas = [];

  for (const [bill, lineas] of Object.entries(grupos)) {
    if (yaRegistradas.has(bill) || yaRegistradasLineas.has(bill)) continue;

    const billOdoo = formatearNumeroFactura(bill);
    const serie = extraerSerie(bill);
    if (!serie) {
      Logger.log('SKIP bill sin serie: ' + bill);
      continue;
    }

    const esPB = lineas[0]['Bill type code'] === 'PB';
    const primeraLinea = lineas[0];
    const importeTotal = lineas.reduce((s, l) => s + (parseFloat(l['Amount']) || 0), 0);
    const clienteNif = String(primeraLinea['Associated tax ID'] || '').trim();
    const clienteNombre = String(primeraLinea['Owner'] || '').trim();
    const vatRate = String(primeraLinea['VAT rate']);
    const reservationNum = String(primeraLinea['Reservation number'] || '').trim();
    const estado = esPB ? 'SKIP_PB' : 'PENDIENTE';
    const numFactura = extraerNumeroFactura(bill);
    const { localizador, agencia } = buscarLocalizador(reservationNum);

    nuevasFacturas.push([
      bill, billOdoo, serie, numFactura, primeraLinea['Closed'] || '',
      reservationNum, localizador, agencia,
      clienteNif, clienteNombre, '',
      lineas.length, importeTotal.toFixed(2), vatRate,
      '', estado, '', '', esPB ? 'Payment Bill — suma 0, no se importa a Odoo' : ''
    ]);

    // Agrupar líneas por (código de Mews, tipo de IVA). Importante:
    // agrupar SOLO por código perdería la separación entre tipos de
    // IVA distintos dentro de la misma factura.
    const gruposLineas = {};
    for (const l of lineas) {
      const key = `${l['Code']}||${l['VAT rate']}`;
      if (!gruposLineas[key]) {
        gruposLineas[key] = {
          mews_code: l['Code'] || '',
          descripcion: mappings.descripciones[l['Code']] || l['Code'] || '',
          vat_rate: String(l['VAT rate']),
          net: 0, vat_amount: 0, amount_bruto: 0,
        };
      }
      gruposLineas[key].net += parseFloat(l['Net']) || 0;
      gruposLineas[key].vat_amount += parseFloat(l['VAT']) || 0;
      gruposLineas[key].amount_bruto += parseFloat(l['Amount']) || 0;
    }

    Object.values(gruposLineas).forEach((g, i) => {
      const taxId = mappings.vat[g.vat_rate] || '';
      const productId = mappings.productos[g.mews_code] || '';
      nuevasLineas.push([
        bill, i + 1, g.mews_code, g.descripcion, g.vat_rate,
        parseFloat(g.net.toFixed(4)), parseFloat(g.vat_amount.toFixed(4)), parseFloat(g.amount_bruto.toFixed(4)),
        productId, taxId, serie
      ]);
    });

    yaRegistradas.add(bill);
  }

  if (nuevasFacturas.length > 0) {
    appendRows(wsFact, nuevasFacturas);
    appendRows(wsLin, nuevasLineas);
  }

  reordenarYRecalcularContinuidad();

  return { nFacturas: nuevasFacturas.length, nLineas: nuevasLineas.length };
}

// ── 2. Procesar todos los JSONs pendientes en Drive ────────────────
function procesarJsonsDeDrive() {
  const ui = SpreadsheetApp.getUi();
  const cfg = getConfig();

  const inboxId = cfg['FOLDER_ID_INBOX'];
  const procesadosId = cfg['FOLDER_ID_PROCESADOS'];
  if (!inboxId) {
    ui.alert('❌ Falta FOLDER_ID_INBOX en CONFIG.');
    return;
  }

  const inbox = DriveApp.getFolderById(inboxId);
  const _esClosed = n => n.includes('CLOSED') || (n.includes('ACCOUNTING') && !n.includes('CREATED'));

  const pendientes = [];
  const iter1 = inbox.getFilesByType(MimeType.PLAIN_TEXT);
  while (iter1.hasNext()) {
    const f = iter1.next();
    if (_esClosed(f.getName().toUpperCase())) pendientes.push(f);
  }
  const iter2 = inbox.getFilesByType('application/json');
  while (iter2.hasNext()) {
    const f = iter2.next();
    if (_esClosed(f.getName().toUpperCase())) pendientes.push(f);
  }

  if (pendientes.length === 0) {
    ui.alert('📭 No hay JSONs pendientes en la carpeta inbox.');
    return;
  }

  const confirmar = ui.alert(
    'Procesar JSONs pendientes',
    `Se encontraron ${pendientes.length} archivo(s):\n\n` +
    pendientes.map(f => '• ' + f.getName()).join('\n') +
    '\n\n¿Procesar y archivar?',
    ui.ButtonSet.YES_NO
  );
  if (confirmar !== ui.Button.YES) return;

  let totalFacturas = 0, procesados = 0, errores = 0;
  const detalle = [];
  const carpetaProcesados = procesadosId ? DriveApp.getFolderById(procesadosId) : null;

  for (const file of pendientes) {
    const nombre = file.getName();
    try {
      const raw = file.getBlob().getDataAsString();
      const data = JSON.parse(raw);
      const meta = detectarTipoReporte(data);

      if (meta.tipo === 'ACCOUNTING_CLOSED') {
        const { nFacturas } = parsearClosed(data);
        totalFacturas += nFacturas;
        detalle.push(`✅ ${nombre}: ${nFacturas} facturas nuevas`);
        registrarLog(meta.tipo, meta.empresa, nFacturas, md5(raw), 'OK_DRIVE', `${nFacturas} facturas`);
      } else {
        detalle.push(`⏭️ ${nombre}: tipo ${meta.tipo} (no es Facturas)`);
        registrarLog(meta.tipo, meta.empresa, meta.numItems, md5(raw), 'IGNORADO', 'No es Accounting Closed');
      }

      if (carpetaProcesados) file.moveTo(carpetaProcesados);
      else file.setTrashed(true);
      procesados++;

    } catch (err) {
      detalle.push(`❌ ${nombre}: ${err.message.substring(0, 80)}`);
      errores++;
    }
  }

  ui.alert(
    '✅ Proceso completado\n\n' +
    `• Archivos procesados: ${procesados}\n` +
    `• Facturas nuevas: ${totalFacturas}\n` +
    `• Errores: ${errores}\n\n` + detalle.join('\n')
  );
}

// ── 3. Enviar facturas PENDIENTES a Odoo ───────────────────────────
function importarFacturas() {
  const ui = SpreadsheetApp.getUi();

  try {
    const cfg = getConfig();
    const uid = getOdooUid(cfg);
    const mappings = getMappings(cfg);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const wsFact = ss.getSheetByName(TAB.FACTURAS);
    const wsLin = ss.getSheetByName(TAB.LINEAS);
    const data = wsFact.getDataRange().getValues();

    if (data.length < 2) {
      ui.alert('No hay facturas registradas todavía.');
      return;
    }

    const todasLineas = cargarLineas(wsLin);
    let creadas = 0, saltadas = 0, errores = 0;
    const errDetail = [];

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const estado = String(row[H_FACT.indexOf('estado')]).trim();
      if (estado !== 'PENDIENTE') { saltadas++; continue; }

      const billMews = String(row[H_FACT.indexOf('bill_mews')]).trim();
      const billOdoo = String(row[H_FACT.indexOf('bill_odoo')]).trim();
      const serie = String(row[H_FACT.indexOf('serie')]).trim();
      const fechaCierre = row[H_FACT.indexOf('fecha_cierre')];
      const clienteNif = String(row[H_FACT.indexOf('cliente_nif')]).trim();
      const importeTotal = parseFloat(row[H_FACT.indexOf('importe_bruto')]) || 0;

      try {
        const companyId = parseInt(cfg['ODOO_COMPANY_ID']);
        if (!companyId) throw new Error('Falta ODOO_COMPANY_ID en CONFIG.');

        // Idempotencia: si ya existe en Odoo (en ESTA compañía), no se duplica
        const existing = odooExec(cfg, uid, 'account.move', 'search_read',
          [[['name', '=', billOdoo], ['move_type', 'in', ['out_invoice', 'out_refund']], ['company_id', '=', companyId]]],
          { fields: ['id', 'name'], limit: 1 }
        );
        if (existing.length > 0) {
          actualizarFila(wsFact, i + 1, H_FACT, {
            estado: 'YA_EXISTE', odoo_invoice_id: existing[0].id, fecha_procesado: ahora(),
            notas: `Ya existía en Odoo (id=${existing[0].id})`
          });
          saltadas++;
          continue;
        }

        const resolucion = resolverPartner(cfg, uid, '', clienteNif,
          String(row[H_FACT.indexOf('cliente_nombre')] || '').trim(), '', cfg.partner_varios_id,
          importeTotal);
        const partnerId = resolucion.partnerId;

        const journalId = mappings.series[serie];
        if (!journalId) throw new Error(`Serie "${serie}" sin diario en CONFIG (añade SERIE_${serie})`);

        const lineas = todasLineas[billMews] || [];
        if (lineas.length === 0) throw new Error('Sin líneas de detalle. Vuelve a importar el Closed.');

        const isRefund = importeTotal < 0;

        const invoiceLines = lineas.map(l => {
          const productId = mappings.productos[l.mews_code] || false;
          const taxId = mappings.vat[String(l.vat_rate)] || false;

          // Signo desde la perspectiva del documento en Odoo:
          // factura normal → net tal cual; abono → signo invertido.
          const netDoc = isRefund ? -l.net : l.net;

          const lineData = {
            product_id: productId,
            price_unit: Math.abs(netDoc),
            quantity: netDoc < 0 ? -1 : 1,
            tax_ids: taxId ? [[6, 0, [taxId]]] : [[6, 0, []]],
            name: l.descripcion || l.mews_code,
          };
          const analyticId = parseInt(cfg['ANALYTIC_ACCOUNT_ID']) || null;
          if (analyticId) lineData['analytic_distribution'] = { [analyticId]: 100 };
          return [0, 0, lineData];
        });

        const localizadorOta = String(row[H_FACT.indexOf('localizador_ota')] || '').trim();

        const invoiceId = odooExec(cfg, uid, 'account.move', 'create', [{
          name: billOdoo,
          move_type: isRefund ? 'out_refund' : 'out_invoice',
          company_id: companyId,
          partner_id: partnerId,
          journal_id: journalId,
          fiscal_position_id: parseInt(cfg['FISCAL_POSITION_ID']) || false,
          invoice_date: formatFechaOdoo(fechaCierre),
          ref: localizadorOta || billMews,
          invoice_line_ids: invoiceLines,
        }], {});

        const created = odooExec(cfg, uid, 'account.move', 'read', [[invoiceId]], { fields: ['name', 'partner_id'] });
        const nombreOdoo = created[0]?.name || billOdoo;
        const partnerNombre = created[0]?.partner_id?.[1] || '';

        actualizarFila(wsFact, i + 1, H_FACT, {
          partner_odoo_id: partnerId, cliente_nombre: partnerNombre,
          estado: 'CREADA', odoo_invoice_id: invoiceId, fecha_procesado: ahora(),
          notas: `Odoo name: ${nombreOdoo}` + (resolucion.detalle ? ` ⚠️ ${resolucion.detalle}` : '')
        });
        creadas++;

      } catch (err) {
        actualizarFila(wsFact, i + 1, H_FACT, { estado: 'ERROR', fecha_procesado: ahora(), notas: err.message });
        errores++;
        errDetail.push(`${billOdoo}: ${err.message}`);
      }

      Utilities.sleep(300);
    }

    let msg = `✅ Proceso completado\n\n• Creadas en Odoo (borrador): ${creadas}\n• Ya existían/saltadas: ${saltadas}\n• Errores: ${errores}`;
    if (errores > 0) msg += '\n\nDetalle:\n' + errDetail.slice(0, 5).join('\n');
    if (creadas > 0) msg += '\n\n📌 Recuerda confirmar las facturas manualmente en Odoo.';
    ui.alert(msg);

  } catch (err) {
    ui.alert(`❌ Error general: ${err.message}`);
    Logger.log('ERROR importarFacturas: ' + err.message + '\n' + err.stack);
  }
}

function reprocesarErrores() {
  const ws = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB.FACTURAS);
  const data = ws.getDataRange().getValues();
  const colEstado = H_FACT.indexOf('estado') + 1;
  let n = 0;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][H_FACT.indexOf('estado')]) === 'ERROR') {
      ws.getRange(i + 1, colEstado).setValue('PENDIENTE');
      ws.getRange(i + 1, H_FACT.indexOf('notas') + 1).setValue('');
      n++;
    }
  }
  SpreadsheetApp.getUi().alert(`${n} factura(s) marcadas de nuevo como PENDIENTE.`);
}

// ── Formato de números de factura ──────────────────────────────────
function extraerNumeroFactura(bill) {
  const s = String(bill || '').trim();
  if (s.startsWith('PAYMENT BILL')) return parseInt(s.replace('PAYMENT BILL', '').trim()) || 0;
  const m = s.match(/\d+$/);
  return m ? parseInt(m[0]) : 0;
}

function formatearNumeroFactura(bill) {
  const s = String(bill || '').trim();
  if (s.startsWith('PAYMENT BILL')) return 'PB/' + parseInt(s.replace('PAYMENT BILL', '').trim());
  const tokenConBarra = s.split(/\s+/).find(t => t.includes('/'));
  if (tokenConBarra) return tokenConBarra;
  const m = s.match(/([A-Z]+)(\d+)$/);
  return m ? `${m[1]}/${m[2]}` : s;
}

function extraerSerie(bill) {
  const s = String(bill || '').trim();
  if (s.startsWith('PAYMENT BILL')) return 'PB';
  const m = s.match(/^([A-Z]+)\s/);
  return m ? m[1] : '';
}

// ── Continuidad y huecos de numeración ─────────────────────────────
function reordenarYRecalcularContinuidad() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const wsFact = ss.getSheetByName(TAB.FACTURAS);
  const data = wsFact.getDataRange().getValues();
  if (data.length <= FILA_DATOS_INICIO_FACTURAS) return;

  const headers = data[0];
  const colSerie = headers.indexOf('serie');
  const colNum = headers.indexOf('num_factura');
  const colCont = headers.indexOf('continuidad');
  const colBill = headers.indexOf('bill_mews');

  const filasDatos = data.slice(FILA_DATOS_INICIO_FACTURAS).filter(r => r[colBill]);
  if (filasDatos.length === 0) return;

  filasDatos.sort((a, b) => {
    const serieA = String(a[colSerie] || ''), serieB = String(b[colSerie] || '');
    const esPB_A = serieA === 'PB', esPB_B = serieB === 'PB';
    if (esPB_A && !esPB_B) return 1;
    if (!esPB_A && esPB_B) return -1;
    if (serieA !== serieB) return serieA.localeCompare(serieB);
    return (parseInt(a[colNum]) || 0) - (parseInt(b[colNum]) || 0);
  });

  const ultimoPorSerie = {};
  for (const fila of filasDatos) {
    const serie = String(fila[colSerie] || '');
    const num = parseInt(fila[colNum]) || 0;
    const esPB = String(fila[colBill] || '').startsWith('PAYMENT BILL');

    if (esPB || !serie || serie === 'PB') { fila[colCont] = '—'; continue; }

    if (ultimoPorSerie[serie] === undefined) {
      fila[colCont] = '🆕 primera';
    } else {
      const esperado = ultimoPorSerie[serie] + 1;
      if (num === esperado) fila[colCont] = '✅';
      else if (num > esperado) fila[colCont] = `⚠️ salto: falta ${esperado}→${num - 1}`;
      else fila[colCont] = `⚠️ duplicado o anterior`;
    }
    ultimoPorSerie[serie] = num;
  }

  const numCols = headers.length;
  wsFact.getRange(FILA_DATOS_INICIO_FACTURAS + 1, 1, filasDatos.length, numCols).setValues(filasDatos);

  actualizarHuecos(filasDatos, headers);
}

function actualizarHuecos(filasDatos, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let wsHuecos = ss.getSheetByName(TAB.HUECOS);
  if (!wsHuecos) {
    wsHuecos = ss.insertSheet(TAB.HUECOS);
    wsHuecos.getRange(1, 1, 1, 5).setValues([['serie', 'desde', 'hasta', 'num_faltantes', 'detectado']]);
    wsHuecos.getRange(1, 1, 1, 5).setFontWeight('bold');
    wsHuecos.setFrozenRows(1);
  } else if (wsHuecos.getLastRow() > 1) {
    wsHuecos.getRange(2, 1, wsHuecos.getLastRow() - 1, 5).clearContent();
  }

  const colSerie = headers.indexOf('serie');
  const colNum = headers.indexOf('num_factura');
  const colBill = headers.indexOf('bill_mews');

  const huecos = [];
  const ultimoPorSerie = {};

  for (const fila of filasDatos) {
    const serie = String(fila[colSerie] || '');
    const num = parseInt(fila[colNum]) || 0;
    const esPB = String(fila[colBill] || '').startsWith('PAYMENT BILL');
    if (esPB || !serie || serie === 'PB' || num === 0) continue;

    if (ultimoPorSerie[serie] !== undefined) {
      const esperado = ultimoPorSerie[serie] + 1;
      if (num > esperado) {
        huecos.push([serie, esperado, num - 1, num - esperado, ahora()]);
      }
    }
    ultimoPorSerie[serie] = num;
  }

  if (huecos.length > 0) {
    wsHuecos.getRange(wsHuecos.getLastRow() + 1, 1, huecos.length, 5).setValues(huecos);
  }
}

function verificarContinuidad() {
  reordenarYRecalcularContinuidad();
  const wsHuecos = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB.HUECOS);
  const n = wsHuecos && wsHuecos.getLastRow() > 1 ? wsHuecos.getLastRow() - 1 : 0;
  SpreadsheetApp.getUi().alert(
    n === 0
      ? '✅ Sin huecos de numeración detectados.'
      : `⚠️ ${n} hueco(s) de numeración detectados. Revisa la pestaña ${TAB.HUECOS}.`
  );
}
