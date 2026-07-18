/**
 * ================================================================
 *  FASE 4 — SALDAR (Conciliación de facturas contra pagos)
 * ================================================================
 *  Usa las líneas Type:Payment que Fase 1 ya guardó en PAGOS_CLOSED
 *  al parsear el Closed — no hace falta ningún archivo nuevo. Solo se
 *  puede ejecutar cuando las facturas de esos días ya están
 *  confirmadas en Odoo (no en borrador), porque conciliar necesita
 *  una línea contable ya validada.
 *
 *  Garantía de partida (confirmada): Mews solo cierra un Bill cuando
 *  sus pagos suman exactamente el total de la factura, y el cuadre de
 *  Gross de Fase 1 ya garantiza que ese total coincide con Odoo. Por
 *  eso NO hay cuenta de diferencias/redondeo aquí — si una factura
 *  concreta no cuadra exacto, es una anomalía real, no algo a
 *  absorber en silencio, y bloquea el día entero hasta resolverse.
 *
 *  CONFIG necesario:
 *    FASE4_JOURNAL_ID        → diario del asiento de conciliación
 *    FASE4_CUENTA_430        → cuenta de Clientes (a conciliar)
 *    FASE4_CUENTA_<CODE>     → cuenta puente por cada código de pago
 *                              del Closed (ej. FASE4_CUENTA_SAN),
 *                              normalmente la misma 579012/438100 que
 *                              ya usa Fase 2, pero indexado por el
 *                              código corto (SAN, PDQ, CAS...), no
 *                              por el texto largo de Accounting category.
 *    FASE4_BILLS_EXCLUIR     → opcional, patrones de Bill a ignorar
 *                              (bills técnicos de Mews sin factura en
 *                              Odoo), separados por |
 *
 *  Si algún pago del día tiene un código sin mapear, o una factura
 *  que no está en FACTURAS o no está confirmada en Odoo, se bloquea
 *  el asiento de ESE DÍA entero — no se crea nada parcial.
 * ================================================================
 */

function procesarSaldarFacturas() {
  const ui = SpreadsheetApp.getUi();
  const cfg = getConfig();
  const uid = getOdooUid(cfg);
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const wsPagos = ss.getSheetByName(TAB.PAGOS);
  if (!wsPagos || wsPagos.getLastRow() < 2) {
    ui.alert('No hay pagos pendientes en PAGOS_CLOSED todavía.');
    return;
  }

  const excluirBills = (cfg['FASE4_BILLS_EXCLUIR'] || '').split('|').map(s => s.trim()).filter(Boolean);

  const data = wsPagos.getDataRange().getValues();
  const porFecha = {};
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const estado = String(row[H_PAGOS.indexOf('estado')]).trim();
    if (estado !== 'PENDIENTE') continue;

    const bill = String(row[H_PAGOS.indexOf('bill_mews')]).trim();
    if (excluirBills.some(p => bill.toLowerCase().includes(p.toLowerCase()))) continue;

    const fecha = String(row[H_PAGOS.indexOf('fecha_cierre')]).trim();
    if (!porFecha[fecha]) porFecha[fecha] = [];
    porFecha[fecha].push({ rowNum: i + 1, bill, code: String(row[H_PAGOS.indexOf('code')]).trim(), amount: parseFloat(row[H_PAGOS.indexOf('amount')]) });
  }

  const fechas = Object.keys(porFecha).sort();
  if (fechas.length === 0) {
    ui.alert('No hay pagos con estado PENDIENTE (excluyendo bills técnicos).');
    return;
  }

  const confirmar = ui.alert(
    'Saldar facturas',
    `Se van a procesar ${fechas.length} día(s):\n` + fechas.map(f => '  • ' + f).join('\n') + '\n\n¿Continuar?',
    ui.ButtonSet.YES_NO
  );
  if (confirmar !== ui.Button.YES) return;

  const resumen = [];
  for (const fecha of fechas) {
    try {
      const r = saldarFacturasDelDia(cfg, uid, fecha, porFecha[fecha]);
      resumen.push(`${fecha}: ${r.mensaje}`);
    } catch (e) {
      resumen.push(`${fecha}: ❌ ${e.message}`);
      Logger.log('ERROR saldarFacturasDelDia ' + fecha + ': ' + e.message);
    }
  }

  ui.alert('✅ Proceso completado\n\n' + resumen.join('\n'));
}

function saldarFacturasDelDia(cfg, uid, fecha, pagosDelDia) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const wsPagos = ss.getSheetByName(TAB.PAGOS);
  const wsFact = ss.getSheetByName(TAB.FACTURAS);

  const journalId = parseInt(cfg['FASE4_JOURNAL_ID']);
  const cta430 = parseInt(cfg['FASE4_CUENTA_430']);
  const companyId = parseInt(cfg['ODOO_COMPANY_ID']);
  if (!journalId) throw new Error('Falta FASE4_JOURNAL_ID en CONFIG.');
  if (!cta430) throw new Error('Falta FASE4_CUENTA_430 en CONFIG.');
  if (!companyId) throw new Error('Falta ODOO_COMPANY_ID en CONFIG.');

  const ref = `MEWS-COB4/${fecha}`;
  const existente = odooExec(cfg, uid, 'account.move', 'search_read',
    [[['ref', '=', ref], ['journal_id', '=', journalId]]], { fields: ['id'], limit: 1 });
  if (existente.length > 0) {
    return { creado: false, mensaje: `Ya existe un asiento para ${fecha} (id ${existente[0].id}), no se duplica.` };
  }

  // 0. Bills "solo pagos" cuyo total neta a cero (ej. un cobro
  // fallido + repetido por otro canal, como RPHF000055/56 que ya
  // detectamos en Fase 1) — no hay nada real que conciliar, así que
  // se excluyen ENTERAS antes de tocar nada más. Importante: se
  // excluyen tanto del reparto por código como del cruce por
  // factura, para que el asiento siga cuadrando (si solo se saltara
  // el lado de la factura, el lado de las cuentas puente quedaría
  // descuadrado por ese importe).
  const totalPorBillTodos = {};
  for (const p of pagosDelDia) {
    totalPorBillTodos[p.bill] = (totalPorBillTodos[p.bill] || 0) + p.amount;
  }
  const billsSinMovimiento = new Set(
    Object.entries(totalPorBillTodos)
      .filter(([, total]) => Math.abs(total) < 0.01)
      .map(([bill]) => bill)
  );
  const pagosRelevantes = pagosDelDia.filter(p => !billsSinMovimiento.has(p.bill));

  // Los que se quedan fuera se marcan igualmente, para no volver a
  // revisarlos cada vez que se ejecute esto.
  for (const p of pagosDelDia) {
    if (billsSinMovimiento.has(p.bill)) {
      actualizarFila(wsPagos, p.rowNum, H_PAGOS, { estado: 'SIN_MOVIMIENTO', notas: 'Pagos de este bill suman 0 — nada que conciliar.' });
    }
  }

  if (pagosRelevantes.length === 0) {
    return { creado: false, mensaje: `Todos los pagos de ${fecha} eran de bills sin movimiento neto — nada que conciliar.` };
  }

  // 1. Validar TODOS los códigos de pago del día antes de tocar nada
  const porCodigo = {};
  const codigosSinMapeo = new Set();
  for (const p of pagosRelevantes) {
    const cuentaId = parseInt(cfg[`FASE4_CUENTA_${p.code}`]);
    if (!cuentaId) { codigosSinMapeo.add(p.code); continue; }
    porCodigo[p.code] = (porCodigo[p.code] || 0) + p.amount;
  }
  if (codigosSinMapeo.size > 0) {
    throw new Error('Códigos de pago sin mapeo (FASE4_CUENTA_<CODE>): ' + [...codigosSinMapeo].join(', ') + ' — día bloqueado.');
  }

  // 2. Agrupar por factura (Bill) y cruzar contra FACTURAS/Odoo — TODAS
  // tienen que encontrarse y estar CREADA, o se bloquea el día entero.
  const porBill = {};
  for (const p of pagosRelevantes) {
    if (!porBill[p.bill]) porBill[p.bill] = 0;
    porBill[p.bill] += p.amount;
  }

  const factData = wsFact.getDataRange().getValues();
  const facturaPorBill = {};
  for (let i = 1; i < factData.length; i++) {
    facturaPorBill[String(factData[i][H_FACT.indexOf('bill_mews')]).trim()] = {
      rowNum: i + 1,
      estado: String(factData[i][H_FACT.indexOf('estado')]).trim(),
      invoiceId: factData[i][H_FACT.indexOf('odoo_invoice_id')],
      invoiceName: factData[i][H_FACT.indexOf('bill_odoo')],
    };
  }

  const billsProblema = [];
  const facturasAConciliar = [];

  for (const [bill, totalPagado] of Object.entries(porBill)) {
    const f = facturaPorBill[bill];
    if (!f) { billsProblema.push(`${bill}: no está en FACTURAS`); continue; }
    if (f.estado !== 'CREADA' || !f.invoiceId) { billsProblema.push(`${bill}: estado "${f.estado}", no está creada/confirmada en Odoo`); continue; }

    const odoo = odooExec(cfg, uid, 'account.move', 'read', [[parseInt(f.invoiceId)]],
      { fields: ['state', 'amount_residual', 'amount_total', 'partner_id'] });
    if (!odoo[0]) { billsProblema.push(`${bill}: factura ${f.invoiceId} no encontrada en Odoo`); continue; }
    if (odoo[0].state !== 'posted') { billsProblema.push(`${bill}: factura no confirmada en Odoo (estado "${odoo[0].state}")`); continue; }

    // Sanity check: el pago debería sumar exactamente el residual.
    // Esto NO debería fallar nunca (esa es la garantía de partida) —
    // si falla, es una anomalía real, no un redondeo a absorber.
    const residual = Math.round(odoo[0].amount_residual * 100) / 100;
    const pagado = Math.round(Math.abs(totalPagado) * 100) / 100;
    if (Math.abs(residual - pagado) > 0.01) {
      billsProblema.push(`${bill}: pagos suman ${pagado}€ pero la factura tiene ${residual}€ pendiente (no cuadra)`);
      continue;
    }

    facturasAConciliar.push({
      bill, invoiceId: parseInt(f.invoiceId), invoiceName: f.invoiceName,
      partnerId: odoo[0].partner_id[0], importe: pagado, esRectificativa: totalPagado < 0,
    });
  }

  if (billsProblema.length > 0) {
    throw new Error('Facturas con problema (día bloqueado): ' + billsProblema.join(' | '));
  }

  // 3. Construir el asiento: débito por código (agrupado), crédito por factura
  const lineas = [];
  for (const [code, importe] of Object.entries(porCodigo)) {
    const cuentaId = parseInt(cfg[`FASE4_CUENTA_${code}`]);
    lineas.push({ account_id: cuentaId, name: `Saldar ${code} — ${fecha}`, debit: Math.round(Math.abs(importe) * 100) / 100, credit: 0 });
  }
  for (const f of facturasAConciliar) {
    if (!f.esRectificativa) {
      lineas.push({ account_id: cta430, partner_id: f.partnerId, name: f.invoiceName, debit: 0, credit: f.importe });
    } else {
      lineas.push({ account_id: cta430, partner_id: f.partnerId, name: f.invoiceName, debit: f.importe, credit: 0 });
    }
  }

  // 4. Crear, validar y conciliar
  const entryId = odooExec(cfg, uid, 'account.move', 'create', [{
    move_type: 'entry', journal_id: journalId, company_id: companyId,
    date: fecha, ref: ref, line_ids: lineas.map(l => [0, 0, l]),
  }], {});

  try {
    odooExec(cfg, uid, 'account.move', 'action_post', [[entryId]], {});
  } catch (e) {
    throw new Error(`Asiento creado (id ${entryId}) pero no se pudo validar: ${e.message}`);
  }

  const errores = conciliarFacturasFase4(cfg, uid, entryId, facturasAConciliar, cta430);

  // 5. Marcar los pagos como procesados (los SIN_MOVIMIENTO ya se
  // marcaron antes, no se tocan aquí)
  for (const p of pagosRelevantes) {
    actualizarFila(wsPagos, p.rowNum, H_PAGOS, { estado: 'CONCILIADO', notas: `Asiento ${entryId}` });
  }

  const msg = errores.length === 0
    ? `Asiento creado y conciliado (id ${entryId}), ${facturasAConciliar.length} factura(s).`
    : `Asiento creado (id ${entryId}) pero con errores de conciliación: ${errores.join(' | ')}`;

  return { creado: true, mensaje: msg };
}

// Mismo patrón que ya conocíamos del repo viejo (confirmado que era
// correcto): el reconcile() de Odoo 19 a veces lanza un error de
// serialización XML-RPC aunque la conciliación SÍ se ejecutó — se
// verifica leyendo el estado real antes de dar el error por bueno.
function conciliarFacturasFase4(cfg, uid, entryId, facturas, cta430) {
  const errores = [];

  const moveLines = odooExec(cfg, uid, 'account.move.line', 'search_read',
    [[['move_id', '=', entryId], ['account_id', '=', cta430]]],
    { fields: ['id', 'name', 'partner_id', 'debit', 'credit'] }
  );

  for (const f of facturas) {
    try {
      const lineaAsiento = moveLines.find(l =>
        l.name === f.invoiceName &&
        Array.isArray(l.partner_id) && l.partner_id[0] === f.partnerId &&
        (Math.abs(l.credit - f.importe) < 0.01 || Math.abs(l.debit - f.importe) < 0.01)
      );
      if (!lineaAsiento) { errores.push(`${f.invoiceName} (línea del asiento no localizada)`); continue; }

      const lineaFactura = odooExec(cfg, uid, 'account.move.line', 'search_read',
        [[['move_id', '=', f.invoiceId], ['account_id', '=', cta430], ['reconciled', '=', false]]],
        { fields: ['id'], limit: 1 }
      );
      if (!lineaFactura || lineaFactura.length === 0) { errores.push(`${f.invoiceName} (sin línea pendiente en ${cta430})`); continue; }

      try {
        odooExec(cfg, uid, 'account.move.line', 'reconcile', [[lineaAsiento.id, lineaFactura[0].id]], {});
      } catch (eReconcile) {
        const esErrorSerializacion = eReconcile.message && (
          eReconcile.message.includes('dumps') || eReconcile.message.includes('xmlrpc') || eReconcile.message.includes('Traceback')
        );
        if (esErrorSerializacion) {
          const check = odooExec(cfg, uid, 'account.move.line', 'search_read',
            [[['id', '=', lineaFactura[0].id], ['reconciled', '=', true]]], { fields: ['id'], limit: 1 });
          if (!(check && check.length > 0)) {
            errores.push(`${f.invoiceName} (reconcile falló de verdad: ${eReconcile.message.substring(0, 80)})`);
          }
          // si check sí encuentra reconciled=true, error cosmético, no se añade a errores
        } else {
          errores.push(`${f.invoiceName} (${eReconcile.message.substring(0, 80)})`);
        }
      }
    } catch (e) {
      errores.push(`${f.invoiceName} (${e.message.substring(0, 80)})`);
    }
  }

  return errores;
}
