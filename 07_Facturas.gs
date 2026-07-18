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

    const primeraLinea = lineas[0];
    const billTypeCode = String(primeraLinea['Bill type code'] || '').trim();
    const serieTexto = extraerSerie(bill);

    // Exclusión explícita por tipo (ej. "HIP" de Tests/Cross-settlements
    // internos de Mews que siempre netean a 0). Vacío por defecto — no
    // cambia nada hasta que se añada BILL_TYPE_EXCLUIR en CONFIG.
    const excluidosBillType = (cfg['BILL_TYPE_EXCLUIR'] || '').split('|').map(s => s.trim()).filter(Boolean);
    if (billTypeCode && excluidosBillType.includes(billTypeCode)) {
      Logger.log(`SKIP bill type excluido (${billTypeCode}): ` + bill);
      continue;
    }

    // Serie por prioridad: el campo que da Mews directamente en
    // "Bill type code" (fiable) y, si viene vacío, el texto del Bill
    // como respaldo. Antes solo se miraba el texto, y bills como
    // "Cancellations 0000053" (que Mews SÍ marca como PHC en este
    // campo) se perdían en silencio porque el texto no encaja en el
    // patrón "LETRAS espacio NÚMERO".
    const serie = billTypeCode || serieTexto;
    if (!serie) {
      Logger.log('SKIP bill sin serie: ' + bill);
      continue;
    }
    const billOdoo = formatearNumeroFactura(bill, serie);

    const esPB = billTypeCode === 'PB';
    const importeTotal = lineas.reduce((s, l) => s + (parseFloat(l['Amount']) || 0), 0);
    // Associated tax ID es el NIF principal; Owner tax ID es el
    // respaldo si el primero viene vacío (se perdía en la reescritura
    // anterior — Odoo se quedaba sin NIF aunque Mews sí lo tuviera en
    // el segundo campo).
    const clienteNif = String(primeraLinea['Associated tax ID'] || primeraLinea['Owner tax ID'] || '').trim();
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
  avisarBillsSoloPago(items, cfg);
  extraerPagosParaFase4(items);

  return { nFacturas: nuevasFacturas.length, nLineas: nuevasLineas.length };
}

// ── Extraer líneas Type: Payment para Fase 4 (Saldar) ──────────────
// Fase 1 solo usa Type: Revenue para las facturas — estas líneas de
// pago no se usan aquí, se guardan para cuando Fase 4 las necesite,
// más adelante, una vez las facturas estén confirmadas en Odoo.
function extraerPagosParaFase4(items) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let wsPagos = ss.getSheetByName(TAB.PAGOS);
  if (!wsPagos) {
    wsPagos = ss.insertSheet(TAB.PAGOS);
    wsPagos.getRange(1, 1, 1, H_PAGOS.length).setValues([H_PAGOS]);
    wsPagos.getRange(1, 1, 1, H_PAGOS.length).setFontWeight('bold');
    wsPagos.setFrozenRows(1);
  }

  // Dedup: no reinsertar la misma línea si este JSON ya se procesó
  // antes. OJO: se cuenta por OCURRENCIAS, no solo presencia — dos
  // pagos distintos pueden tener el mismo bill+código+importe+fecha
  // (ej. dos cobros de tarjeta por la misma cantidad), y no son
  // duplicados entre sí, solo lo son si YA había esa misma cantidad
  // de ocurrencias guardada de antes.
  const existentes = wsPagos.getDataRange().getValues();
  const huellaCountExistente = {};
  for (let i = 1; i < existentes.length; i++) {
    const h = `${existentes[i][0]}|||${existentes[i][1]}|||${existentes[i][2]}|||${existentes[i][3]}`;
    huellaCountExistente[h] = (huellaCountExistente[h] || 0) + 1;
  }

  const huellaCountEstaTanda = {};
  const nuevas = [];
  for (const item of items) {
    if (item['Type'] !== 'Payment') continue;
    const bill = String(item['Bill'] || '').trim();
    if (!bill) continue;
    const code = String(item['Code'] || '').trim();
    const amount = parseFloat(item['Amount']);
    if (isNaN(amount) || amount === 0) continue;
    const fecha = String(item['Closed'] || '').split('T')[0];

    const huella = `${bill}|||${code}|||${amount}|||${fecha}`;
    const vistosEnEstaTanda = huellaCountEstaTanda[huella] || 0;
    huellaCountEstaTanda[huella] = vistosEnEstaTanda + 1;

    // Esta es la aparición número (vistosEnEstaTanda+1) de esta huella
    // en esta tanda. Solo se salta si YA había al menos esa cantidad
    // guardada — si no, es una línea nueva de verdad, aunque se
    // parezca a otra ya guardada.
    if (vistosEnEstaTanda < (huellaCountExistente[huella] || 0)) continue;

    nuevas.push([bill, code, amount, fecha, 'PENDIENTE', '']);
  }

  if (nuevas.length > 0) {
    wsPagos.getRange(wsPagos.getLastRow() + 1, 1, nuevas.length, H_PAGOS.length).setValues(nuevas);
  }
}

// ── Bills "solo con pagos" (sin ninguna línea Revenue) ──────────────
// Dos casos, distinto tratamiento:
//  - Si sus pagos netean a CERO (ej. un cobro fallido + repetido por
//    otro canal): se crea un documento a 0€ en Odoo, con una línea
//    por cada movimiento de pago real, TODAS contra la cuenta 555
//    (CUENTA_REDONDEO_ID) — así el efecto contable neto es cero, pero
//    las dos patas del error quedan visibles y la numeración no deja
//    un hueco. Tipo de documento por serie: si el Bill type code
//    empieza por "R" (RPHF/RPHC), abono; si no, factura normal.
//  - Si NO netean a cero: sigue siendo un error operativo real (dinero
//    sin factura) — se avisa en HUECOS_NUMERACION, no se inventa nada.
// Los "Payment Bill" (PB) y cualquier tipo en BILL_TYPE_EXCLUIR se
// excluyen de ambos casos: esos ya se ignoran a propósito.
function avisarBillsSoloPago(items, cfg) {
  const excluidosBillType = (cfg['BILL_TYPE_EXCLUIR'] || '').split('|').map(s => s.trim()).filter(Boolean);

  const billsConRevenue = new Set();
  const primeraLineaPorBill = {};
  const lineasPagoPorBill = {};
  for (const item of items) {
    const bill = String(item['Bill'] || '').trim();
    if (!bill) continue;
    if (item['Type'] === 'Revenue') billsConRevenue.add(bill);
    if (!primeraLineaPorBill[bill]) primeraLineaPorBill[bill] = item;
    if (item['Type'] === 'Payment') {
      if (!lineasPagoPorBill[bill]) lineasPagoPorBill[bill] = [];
      lineasPagoPorBill[bill].push(item);
    }
  }

  const paraCrear = [];
  const sospechosos = [];

  for (const [bill, item] of Object.entries(primeraLineaPorBill)) {
    if (billsConRevenue.has(bill)) continue;
    const billTypeCode = String(item['Bill type code'] || '').trim();
    if (!billTypeCode || billTypeCode === 'PB' || excluidosBillType.includes(billTypeCode)) continue;

    const lineasPago = lineasPagoPorBill[bill] || [];
    const totalPago = lineasPago.reduce((s, l) => s + (parseFloat(l['Amount']) || 0), 0);

    if (Math.abs(totalPago) < 0.01 && lineasPago.length > 0) {
      paraCrear.push({ bill, billTypeCode, lineasPago });
    } else {
      sospechosos.push({ bill, billTypeCode });
    }
  }

  if (paraCrear.length > 0) {
    crearDocumentosAjuste555(paraCrear, cfg);
  }

  if (sospechosos.length === 0) return;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let wsHuecos = ss.getSheetByName(TAB.HUECOS);
  if (!wsHuecos) {
    wsHuecos = ss.insertSheet(TAB.HUECOS);
    wsHuecos.getRange(1, 1, 1, 5).setValues([['serie', 'desde', 'hasta', 'num_faltantes', 'detectado']]);
    wsHuecos.getRange(1, 1, 1, 5).setFontWeight('bold');
    wsHuecos.setFrozenRows(1);
  }

  const yaAvisados = new Set(
    wsHuecos.getLastRow() > 1
      ? wsHuecos.getRange(2, 1, wsHuecos.getLastRow() - 1, 1).getValues().map(r => String(r[0]))
      : []
  );

  const nuevasFilas = [];
  for (const { bill, billTypeCode } of sospechosos) {
    const etiqueta = `⚠️ ${billTypeCode} SOLO PAGOS, sin factura — "${bill}"`;
    if (yaAvisados.has(etiqueta)) continue;
    nuevasFilas.push([etiqueta, '', '', '', ahora()]);
  }

  if (nuevasFilas.length > 0) {
    wsHuecos.getRange(wsHuecos.getLastRow() + 1, 1, nuevasFilas.length, 5).setValues(nuevasFilas);
  }
}

// Crea, para cada bill "solo pagos que suman cero", un documento a 0€
// con una línea por movimiento de pago real, todas contra la cuenta
// 555 — mismo circuito que una factura normal (FACTURAS/FACTURAS_LINEAS,
// PENDIENTE, pasa por importarFacturas), solo que las líneas llevan el
// marcador 'AJUSTE_555' en vez de un producto real.
function crearDocumentosAjuste555(paraCrear, cfg) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const wsFact = ss.getSheetByName(TAB.FACTURAS);
  const wsLin = ss.getSheetByName(TAB.LINEAS);

  const yaRegistradas = getValoresExistentes(wsFact, 'bill_mews', H_FACT);

  const nuevasFacturas = [];
  const nuevasLineas = [];

  for (const { bill, billTypeCode, lineasPago } of paraCrear) {
    if (yaRegistradas.has(bill)) continue;

    const serie = billTypeCode;
    const billOdoo = formatearNumeroFactura(bill, serie);
    const numFactura = extraerNumeroFactura(bill);
    const primeraLinea = lineasPago[0];
    const clienteNif = String(primeraLinea['Associated tax ID'] || primeraLinea['Owner tax ID'] || '').trim();
    const clienteNombre = String(primeraLinea['Owner'] || '').trim();
    const reservationNum = String(primeraLinea['Reservation number'] || '').trim();
    const { localizador, agencia } = buscarLocalizador(reservationNum);

    nuevasFacturas.push([
      bill, billOdoo, serie, numFactura, primeraLinea['Closed'] || '',
      reservationNum, localizador, agencia,
      clienteNif, clienteNombre, '',
      lineasPago.length, '0.00', '',
      '', 'PENDIENTE', '', '',
      'Documento de ajuste a 0€ — cobro corregido por otro canal, sin efecto neto (ver líneas)'
    ]);

    lineasPago.forEach((l, i) => {
      const code = String(l['Code'] || '').trim();
      const amount = parseFloat(l['Amount']) || 0;
      nuevasLineas.push([
        bill, i + 1, code, `Ajuste operativo — pago vía ${code}`, '',
        amount, 0, amount,
        'AJUSTE_555', '', serie
      ]);
    });

    yaRegistradas.add(bill);
  }

  if (nuevasFacturas.length > 0) {
    appendRows(wsFact, nuevasFacturas);
    appendRows(wsLin, nuevasLineas);
  }
}

// ── 2. Procesar todos los JSONs pendientes en Drive ────────────────
function procesarJsonsDeDrive() {
  const ui = SpreadsheetApp.getUi();

  const pendientes = listarJsonsPendientesFacturas();
  if (pendientes === null) { ui.alert('❌ Falta FOLDER_ID_INBOX en CONFIG.'); return; }
  if (pendientes.length === 0) { ui.alert('📭 No hay JSONs pendientes en la carpeta inbox.'); return; }

  const confirmar = ui.alert(
    'Procesar JSONs pendientes',
    `Se encontraron ${pendientes.length} archivo(s):\n\n` +
    pendientes.map(f => '• ' + f.getName()).join('\n') +
    '\n\n¿Procesar y archivar?',
    ui.ButtonSet.YES_NO
  );
  if (confirmar !== ui.Button.YES) return;

  const r = procesarJsonsDeDriveCore(pendientes);
  ui.alert(
    '✅ Proceso completado\n\n' +
    `• Archivos procesados: ${r.procesados}\n` +
    `• Facturas nuevas: ${r.totalFacturas}\n` +
    `• Errores: ${r.errores}\n\n` + r.detalle.join('\n')
  );
}

// Sin UI — la usa tanto el menú (arriba) como el panel web.
function listarJsonsPendientesFacturas() {
  const cfg = getConfig();
  const inboxId = cfg['FOLDER_ID_INBOX'];
  if (!inboxId) return null;

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
  return pendientes;
}

// Sin UI — hace el trabajo real, devuelve un resumen en vez de un alert.
function procesarJsonsDeDriveCore(pendientes) {
  const cfg = getConfig();
  const procesadosId = cfg['FOLDER_ID_PROCESADOS'];
  const carpetaProcesados = procesadosId ? DriveApp.getFolderById(procesadosId) : null;

  let totalFacturas = 0, procesados = 0, errores = 0;
  const detalle = [];

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

  return { procesados, totalFacturas, errores, detalle };
}

// ── 3. Enviar facturas PENDIENTES a Odoo ───────────────────────────
// Sin UI — la usa tanto el wrapper del menú (justo debajo) como el
// panel web. Lanza si hay un error general (CONFIG faltante, etc.);
// los errores por factura individual quedan dentro del resultado.
function importarFacturasCore() {
  const cfg = getConfig();
  const uid = getOdooUid(cfg);
  const mappings = getMappings(cfg);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const wsFact = ss.getSheetByName(TAB.FACTURAS);
    const wsLin = ss.getSheetByName(TAB.LINEAS);
    const data = wsFact.getDataRange().getValues();

    if (data.length < 2) {
      throw new Error('No hay facturas registradas todavía.');
    }

    const todasLineas = cargarLineas(wsLin);
    let creadas = 0, saltadas = 0, errores = 0, discrepanciasCuadre = 0;
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

        // Obligatoria: sin cuenta analítica no se crea la factura.
        const analyticId = parseInt(cfg['ANALYTIC_ACCOUNT_ID']);
        if (!analyticId) throw new Error('Falta ANALYTIC_ACCOUNT_ID en CONFIG.');

        const lineas = todasLineas[billMews] || [];
        if (lineas.length === 0) throw new Error('Sin líneas de detalle. Vuelve a importar el Closed.');

        // Documentos de ajuste a 0€ (bills "solo pagos que suman
        // cero"): el importe total es 0, así que el signo no dice
        // nada — el tipo de documento se decide por la serie (R... =
        // abono, igual que en todo lo demás).
        const esAjuste555 = lineas.some(l => l.odoo_product_id === 'AJUSTE_555');
        const isRefund = esAjuste555 ? serie.startsWith('R') : importeTotal < 0;
        const cuenta555Id = esAjuste555 ? parseInt(cfg['CUENTA_REDONDEO_ID']) : null;
        if (esAjuste555 && !cuenta555Id) throw new Error('Falta CUENTA_REDONDEO_ID en CONFIG (necesaria para documentos de ajuste).');

        const invoiceLines = lineas.map(l => {
          // Signo desde la perspectiva del documento en Odoo:
          // factura normal → net tal cual; abono → signo invertido.
          const netDoc = isRefund ? -l.net : l.net;

          if (l.odoo_product_id === 'AJUSTE_555') {
            // Línea de ajuste: va directa a la cuenta 555, sin
            // producto, sin IVA, sin analítica — no es una venta real.
            return [0, 0, {
              account_id: cuenta555Id,
              price_unit: Math.abs(netDoc),
              quantity: netDoc < 0 ? -1 : 1,
              tax_ids: [[6, 0, []]],
              name: l.descripcion || l.mews_code,
            }];
          }

          const productId = mappings.productos[l.mews_code] || false;
          const taxId = mappings.vat[String(l.vat_rate)] || false;

          return [0, 0, {
            product_id: productId,
            price_unit: Math.abs(netDoc),
            quantity: netDoc < 0 ? -1 : 1,
            tax_ids: taxId ? [[6, 0, [taxId]]] : [[6, 0, []]],
            name: l.descripcion || l.mews_code,
            analytic_distribution: { [analyticId]: 100 },
          }];
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

        const created = odooExec(cfg, uid, 'account.move', 'read', [[invoiceId]], { fields: ['name', 'partner_id', 'amount_total'] });
        const nombreOdoo = created[0]?.name || billOdoo;
        const partnerNombre = created[0]?.partner_id?.[1] || '';

        // Cuadre Gross: se comprueba aquí mismo, en la misma lectura
        // que ya hacíamos, sin llamada extra a Odoo. Solo DETECTA y
        // deja constancia en CUADRE_GROSS — no corrige nada sola. La
        // corrección sigue siendo un botón aparte y deliberado, para
        // poder ver el patrón completo antes de que se autocorrija
        // nada (si un día hay muchas a la vez, es señal de algo más
        // gordo que un simple redondeo).
        const grossOdoo = created[0]?.amount_total;
        if (grossOdoo !== undefined) {
          const diferencia = Math.round((grossOdoo - Math.abs(importeTotal)) * 100) / 100;
          if (Math.abs(diferencia) >= 0.01) {
            registrarDiscrepanciaCuadre(billMews, billOdoo, invoiceId, Math.abs(importeTotal), grossOdoo, diferencia);
            discrepanciasCuadre++;
          }
        }

        actualizarFila(wsFact, i + 1, H_FACT, {
          // cliente_nombre NO se toca — es el nombre real del huésped
          // que viene de Mews, no del partner de Odoo. Sobreescribirlo
          // con "Clientes Varios" cuando cae ahí destruía justo el
          // dato que hace falta para diagnosticar cruces por nombre.
          partner_odoo_id: partnerId,
          estado: 'CREADA', odoo_invoice_id: invoiceId, fecha_procesado: ahora(),
          notas: `Odoo name: ${nombreOdoo} | Partner: ${partnerNombre}` + (resolucion.detalle ? ` ⚠️ ${resolucion.detalle}` : '')
        });
        creadas++;

      } catch (err) {
        actualizarFila(wsFact, i + 1, H_FACT, { estado: 'ERROR', fecha_procesado: ahora(), notas: err.message });
        errores++;
        errDetail.push(`${billOdoo}: ${err.message}`);
      }

      Utilities.sleep(300);
    }

  return { creadas, saltadas, errores, discrepanciasCuadre, errDetail };
}

// Wrapper del menú: llama a la versión Core y muestra el resultado
// con ui.alert. El panel web llama a importarFacturasCore() directamente.
function importarFacturas() {
  const ui = SpreadsheetApp.getUi();
  try {
    const r = importarFacturasCore();
    let msg = `✅ Proceso completado\n\n• Creadas en Odoo (borrador): ${r.creadas}\n• Ya existían/saltadas: ${r.saltadas}\n• Errores: ${r.errores}`;
    if (r.discrepanciasCuadre > 0) msg += `\n• ⚖️ Discrepancias de Gross detectadas: ${r.discrepanciasCuadre} (ver CUADRE_GROSS)`;
    if (r.errores > 0) msg += '\n\nDetalle:\n' + r.errDetail.slice(0, 5).join('\n');
    if (r.creadas > 0) msg += '\n\n📌 Recuerda confirmar las facturas manualmente en Odoo.';
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

// NOTA 2026: para facturas normales esto deja el nombre tal cual viene
// de Mews, CON ESPACIO (ej. "PHF 2000866"), porque el regex de abajo
// exige letras y número pegados y aquí van separados. Para abonos
// (ej. "RPHF Credit Notes RPHF000054") sí engancha y da "RPHF/000054".
// Es una inconsistencia real, pero decidido a propósito: para 2026 se
// sigue como está (ya viene así en producción), se revisa en 2027.
function formatearNumeroFactura(bill, serieResuelta) {
  const s = String(bill || '').trim();
  if (s.startsWith('PAYMENT BILL')) return 'PB/' + parseInt(s.replace('PAYMENT BILL', '').trim());

  // Si el texto del Bill no encaja con la serie resuelta (ej.
  // "Cancellations 0000053" resuelta como PHC vía Bill type code),
  // usar el texto tal cual da un nombre engañoso. Se construye con la
  // serie real + el número, mismo estilo con espacio que las facturas
  // normales — sin tocar PHF/RPHF, que ya salían bien porque ahí el
  // texto SÍ coincide con la serie resuelta.
  if (serieResuelta && extraerSerie(s) !== serieResuelta) {
    const digitos = s.match(/\d+$/);
    if (digitos) return `${serieResuelta} ${digitos[0]}`;
  }

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
  if (data.length < 2) return; // solo cabecera, nada que hacer

  const headers = data[0];
  const colSerie = headers.indexOf('serie');
  const colNum = headers.indexOf('num_factura');
  const colCont = headers.indexOf('continuidad');
  const colBill = headers.indexOf('bill_mews');

  // Todo lo que hay debajo de la cabecera (fila 1) con bill_mews
  // relleno cuenta como dato real — sin asumir ninguna fila "reservada".
  const filasDatos = data.slice(1).filter(r => r[colBill]);
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
    const billMews = String(fila[colBill] || '');
    const esPB = billMews.startsWith('PAYMENT BILL');

    // "Numeración propia": el texto del Bill no encaja con la serie
    // resuelta (ej. "Cancellations 0000053" resuelta como PHC vía
    // Bill type code). No es la misma secuencia correlativa que la
    // serie normal (2000XXX vs 0XXXXXX en Odoo), así que se sigue
    // por separado — pero SÍ se le comprueban huecos, con su propio
    // contador ("bucket"), no se descarta sin más.
    const numeracionPropia = !esPB && serie && extraerSerie(billMews) !== serie;
    const bucket = numeracionPropia ? `${serie}::PROPIA` : serie;
    const sufijo = numeracionPropia ? ' (numeración propia)' : '';

    if (esPB || !serie || serie === 'PB') { fila[colCont] = '—'; continue; }

    if (ultimoPorSerie[bucket] === undefined) {
      fila[colCont] = '🆕 primera' + sufijo;
    } else {
      const esperado = ultimoPorSerie[bucket] + 1;
      if (num === esperado) fila[colCont] = '✅' + sufijo;
      else if (num > esperado) fila[colCont] = `⚠️ salto: falta ${esperado}→${num - 1}` + sufijo;
      else fila[colCont] = `⚠️ duplicado o anterior` + sufijo;
    }
    ultimoPorSerie[bucket] = num;
  }

  const numCols = headers.length;
  wsFact.getRange(2, 1, filasDatos.length, numCols).setValues(filasDatos);

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
  }

  // Los avisos de "SOLO PAGOS" (marcados con ⚠️, ver avisarBillsSoloPago)
  // no se recalculan desde FACTURAS como los huecos normales — se
  // preservan tal cual entre recálculos, en vez de borrarse.
  let avisosPrevios = [];
  if (wsHuecos.getLastRow() > 1) {
    const existentes = wsHuecos.getRange(2, 1, wsHuecos.getLastRow() - 1, 5).getValues();
    avisosPrevios = existentes.filter(r => String(r[0]).startsWith('⚠️'));
    wsHuecos.getRange(2, 1, wsHuecos.getLastRow() - 1, 5).clearContent();
  }
  if (avisosPrevios.length > 0) {
    wsHuecos.getRange(2, 1, avisosPrevios.length, 5).setValues(avisosPrevios);
  }

  const colSerie = headers.indexOf('serie');
  const colNum = headers.indexOf('num_factura');
  const colBill = headers.indexOf('bill_mews');

  const huecos = [];
  const ultimoPorSerie = {};

  for (const fila of filasDatos) {
    const serie = String(fila[colSerie] || '');
    const num = parseInt(fila[colNum]) || 0;
    const billMews = String(fila[colBill] || '');
    const esPB = billMews.startsWith('PAYMENT BILL');
    const numeracionPropia = !esPB && serie && extraerSerie(billMews) !== serie;
    if (esPB || !serie || serie === 'PB' || num === 0) continue;

    const bucket = numeracionPropia ? `${serie}::PROPIA` : serie;
    const etiqueta = numeracionPropia ? `${serie} (numeración propia)` : serie;

    if (ultimoPorSerie[bucket] !== undefined) {
      const esperado = ultimoPorSerie[bucket] + 1;
      if (num > esperado) {
        huecos.push([etiqueta, esperado, num - 1, num - esperado, ahora()]);
      }
    }
    ultimoPorSerie[bucket] = num;
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

// Helper compartido: añade (o crea si no existe) una fila en
// CUADRE_GROSS. La usan tanto importarFacturas (detección al vuelo,
// justo tras crear cada factura) como verificarCuadreConOdoo (repaso
// completo bajo demanda, útil para facturas creadas antes de tener
// esta detección integrada).
function registrarDiscrepanciaCuadre(billMews, billOdoo, invoiceId, grossMews, grossOdoo, diferencia) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let wsCuadre = ss.getSheetByName('CUADRE_GROSS');
  if (!wsCuadre) {
    wsCuadre = ss.insertSheet('CUADRE_GROSS');
    wsCuadre.getRange(1, 1, 1, 8).setValues([[
      'bill_mews', 'bill_odoo', 'odoo_invoice_id', 'gross_mews', 'gross_odoo', 'diferencia', 'estado', 'comprobado'
    ]]);
    wsCuadre.getRange(1, 1, 1, 8).setFontWeight('bold');
    wsCuadre.setFrozenRows(1);
  }
  wsCuadre.appendRow([
    billMews, billOdoo, invoiceId, grossMews.toFixed(2), grossOdoo.toFixed(2),
    diferencia.toFixed(2), 'PENDIENTE', ahora()
  ]);
}

// ── Comprobación de cuadre bajo demanda (repaso completo) ──────────
// Para facturas que ya estaban CREADA antes de tener la detección
// integrada en importarFacturas, o simplemente para volver a repasar
// todo de golpe. Las nuevas ya se detectan solas al importar.
function verificarCuadreConOdoo() {
  const ui = SpreadsheetApp.getUi();
  const r = verificarCuadreConOdooCore();
  ui.alert(
    '✅ Repaso completo terminado\n\n' +
    `• Facturas comprobadas (no detectadas antes): ${r.comprobadas}\n` +
    `• Discrepancias nuevas encontradas: ${r.nuevasDiscrepancias}\n` +
    `• Diferencia acumulada de las nuevas: ${r.sumaDiferencia.toFixed(2)}€\n\n` +
    'Detalle acumulado en la pestaña CUADRE_GROSS (incluye también las detectadas automáticamente al importar).'
  );
}

// Sin UI — la usa el wrapper de arriba y el panel web.
function verificarCuadreConOdooCore() {
  const cfg = getConfig();
  const uid = getOdooUid(cfg);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const wsFact = ss.getSheetByName(TAB.FACTURAS);
  const data = wsFact.getDataRange().getValues();

  let comprobadas = 0, nuevasDiscrepancias = 0;
  let sumaDiferencia = 0;

  const wsCuadreExistente = ss.getSheetByName('CUADRE_GROSS');
  const yaRegistrados = new Set(
    wsCuadreExistente && wsCuadreExistente.getLastRow() > 1
      ? wsCuadreExistente.getRange(2, 1, wsCuadreExistente.getLastRow() - 1, 1).getValues().map(r => String(r[0]))
      : []
  );

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const estado = String(row[H_FACT.indexOf('estado')]).trim();
    const invoiceId = row[H_FACT.indexOf('odoo_invoice_id')];
    if (estado !== 'CREADA' || !invoiceId) continue;

    const billMews = row[H_FACT.indexOf('bill_mews')];
    if (yaRegistrados.has(String(billMews))) continue;

    const billOdoo = row[H_FACT.indexOf('bill_odoo')];
    const grossMews = Math.abs(parseFloat(row[H_FACT.indexOf('importe_bruto')]) || 0);

    try {
      const res = odooExec(cfg, uid, 'account.move', 'read', [[parseInt(invoiceId)]], { fields: ['amount_total'] });
      comprobadas++;
      if (!res[0]) continue;

      const grossOdoo = res[0].amount_total;
      const diferencia = Math.round((grossOdoo - grossMews) * 100) / 100;

      if (Math.abs(diferencia) >= 0.01) {
        registrarDiscrepanciaCuadre(billMews, billOdoo, invoiceId, grossMews, grossOdoo, diferencia);
        nuevasDiscrepancias++;
        sumaDiferencia += diferencia;
      }
    } catch (e) {
      Logger.log('ERROR comprobando cuadre de ' + billMews + ': ' + e.message);
    }
  }

  return { comprobadas, nuevasDiscrepancias, sumaDiferencia };
}

// ── Corrección automática de redondeos pequeños ─────────────────────
// Para las discrepancias dentro de MARGEN_REDONDEO (CONFIG), añade una
// línea de ajuste a la factura (todavía en borrador) contra la cuenta
// CUENTA_REDONDEO_ID, sin IVA, por el importe exacto que falta o sobra
// — así el total en Odoo pasa a coincidir exactamente con Mews. Las
// que superen el margen NO se tocan, se quedan para revisión manual.
function corregirRedondeosAutomaticamente() {
  const ui = SpreadsheetApp.getUi();
  try {
    const r = corregirRedondeosAutomaticamenteCore();
    ui.alert(
      '✅ Corrección de redondeos completada\n\n' +
      `• Corregidas automáticamente (≤ ${r.margen}€): ${r.corregidas}\n` +
      `• Fuera de margen, sin tocar (revisar a mano): ${r.fueraDeMargen}\n` +
      `• Errores al corregir: ${r.errores}`
    );
  } catch (e) {
    ui.alert('❌ ' + e.message);
  }
}

// Sin UI — la usa el wrapper de arriba y el panel web.
function corregirRedondeosAutomaticamenteCore() {
  const cfg = getConfig();
  const uid = getOdooUid(cfg);
  const cuentaId = parseInt(cfg['CUENTA_REDONDEO_ID']);
  const margen = parseFloat(cfg['MARGEN_REDONDEO']);

  if (!cuentaId) throw new Error('Falta CUENTA_REDONDEO_ID en CONFIG.');
  if (isNaN(margen)) throw new Error('Falta MARGEN_REDONDEO en CONFIG (ej. 0.05).');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const wsCuadre = ss.getSheetByName('CUADRE_GROSS');
  if (!wsCuadre || wsCuadre.getLastRow() < 2) {
    throw new Error('No hay nada en CUADRE_GROSS. Ejecuta primero "Comprobar cuadre Gross".');
  }

  const data = wsCuadre.getDataRange().getValues();
  const H_CUADRE = data[0];
  const colEstado = H_CUADRE.indexOf('estado');
  const colDif = H_CUADRE.indexOf('diferencia');
  const colInvoiceId = H_CUADRE.indexOf('odoo_invoice_id');
  const colBillOdoo = H_CUADRE.indexOf('bill_odoo');

  let corregidas = 0, fueraDeMargen = 0, errores = 0;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (String(row[colEstado]).trim() !== 'PENDIENTE') continue;

    const diferencia = parseFloat(row[colDif]);
    if (Math.abs(diferencia) > margen) {
      fueraDeMargen++;
      continue;
    }

    const invoiceId = parseInt(row[colInvoiceId]);
    try {
      odooExec(cfg, uid, 'account.move', 'write', [[invoiceId], {
        invoice_line_ids: [[0, 0, {
          name: 'Ajuste de redondeo Mews ↔ Odoo',
          quantity: 1,
          price_unit: -diferencia,
          tax_ids: [[6, 0, []]],
          account_id: cuentaId,
        }]]
      }], {});

      wsCuadre.getRange(i + 1, colEstado + 1).setValue('CORREGIDO_AUTO');
      corregidas++;
    } catch (e) {
      Logger.log(`ERROR corrigiendo ${row[colBillOdoo]}: ` + e.message);
      wsCuadre.getRange(i + 1, colEstado + 1).setValue('ERROR_CORRECCION');
      errores++;
    }
  }

  return { corregidas, fueraDeMargen, errores, margen };
}
