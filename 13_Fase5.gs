/**
 * ================================================================
 *  FASE 5 — CONSUMO DE ANTICIPOS (solo Ibiza Rocks Direct)
 * ================================================================
 *  Mecánicamente es el mismo circuito que Fase 4 (Debe cuenta puente,
 *  Haber 430, conciliar la factura) — la diferencia es que aquí NO es
 *  dinero nuevo, es consumir un anticipo que ya se cobró antes (vía
 *  Fase 2, código ANTICIPOMEWS) y quedó en la cuenta puente sin
 *  vincular a ninguna factura concreta. Mews no da esa trazabilidad
 *  (qué anticipo concreto corresponde a qué factura) — se concilia
 *  directo contra el saldo de la cuenta.
 *
 *  Solo aplica a los pagos `Code: INV` de bills donde la agencia de
 *  la reserva (columna `agencia` de FACTURAS, viene de RESERVAS →
 *  Reservations) es exactamente la agencia directa configurada (ej.
 *  "Ibiza Rocks Direct") — NO "cualquier bill sin agencia", que
 *  también capturaría otros casos sin relación (ej. Ecotasas sueltas
 *  con Associated profile vacío). Si el bill tiene OTRA agencia real,
 *  el INV significa "facturado, aún sin pagar de verdad" — se deja
 *  tal cual en PENDIENTE_FASE5, no se toca aquí.
 *
 *  Puede ser consumo TOTAL o PARCIAL del importe pendiente de la
 *  factura (Mews mete en INV "lo que quede" tras otros pagos
 *  explícitos, no siempre coincide con el total).
 *
 *  CONFIG necesario:
 *    FASE5_CUENTA_ANTICIPO   → cuenta puente (438) contra la que se
 *                              consume — puede ser la misma que
 *                              FASE4_CUENTA_ANTICIPOMEWS o distinta,
 *                              clave aparte a propósito.
 *  Reutiliza FASE4_CUENTA_430, FASE4_JOURNAL_ID y ODOO_COMPANY_ID.
 *
 *  IMPORTANTE — orden de ejecución: hay que correr Fase 4 del mismo
 *  día ANTES que Fase 5, porque aquí se comprueba el importe pendiente
 *  (amount_residual) de la factura DESPUÉS de lo que Fase 4 ya haya
 *  conciliado — si Fase 5 va primero, el residual todavía incluirá
 *  pagos que Fase 4 aún no ha aplicado.
 * ================================================================
 */

function procesarConsumoAnticipos() {
  const ui = SpreadsheetApp.getUi();

  const candidatos = listarPagosFase5Pendientes();
  if (candidatos.length === 0) {
    ui.alert('No hay pagos INV pendientes de Fase 5 (PENDIENTE_FASE5 en PAGOS_CLOSED).');
    return;
  }

  const porFecha = {};
  for (const p of candidatos) {
    if (!porFecha[p.fecha]) porFecha[p.fecha] = [];
    porFecha[p.fecha].push(p);
  }
  const fechas = Object.keys(porFecha).sort();

  const confirmar = ui.alert(
    'Consumir anticipos (Fase 5)',
    `Se van a revisar ${fechas.length} día(s):\n` + fechas.map(f => '  • ' + f).join('\n') +
    '\n\nSolo se procesan los bills de la agencia directa configurada (FASE5_NOMBRE_AGENCIA_DIRECTA); el resto se queda tal cual, sigue sin pagar de verdad.\n\n¿Continuar?',
    ui.ButtonSet.YES_NO
  );
  if (confirmar !== ui.Button.YES) return;

  const cfg = getConfig();
  const uid = getOdooUid(cfg);
  const resumen = [];
  for (const fecha of fechas) {
    try {
      const r = consumirAnticiposDelDia(cfg, uid, fecha, porFecha[fecha]);
      resumen.push(`${fecha}: ${r.mensaje}`);
    } catch (e) {
      resumen.push(`${fecha}: ❌ ${e.message}`);
      Logger.log('ERROR consumirAnticiposDelDia ' + fecha + ': ' + e.message);
    }
  }

  ui.alert('✅ Proceso completado\n\n' + resumen.join('\n'));
}

function listarPagosFase5Pendientes() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const wsPagos = ss.getSheetByName(TAB.PAGOS);
  if (!wsPagos || wsPagos.getLastRow() < 2) return [];

  const data = wsPagos.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const estado = String(row[H_PAGOS.indexOf('estado')]).trim();
    if (estado !== 'PENDIENTE_FASE5') continue;
    out.push({
      rowNum: i + 1,
      bill: String(row[H_PAGOS.indexOf('bill_mews')]).trim(),
      code: String(row[H_PAGOS.indexOf('code')]).trim(),
      amount: parseFloat(row[H_PAGOS.indexOf('amount')]),
      fecha: formatFechaOdoo(row[H_PAGOS.indexOf('fecha_cierre')]),
    });
  }
  return out;
}

function consumirAnticiposDelDia(cfg, uid, fecha, pagos) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const wsPagos = ss.getSheetByName(TAB.PAGOS);
  const wsFact = ss.getSheetByName(TAB.FACTURAS);

  const cuentaAnticipo = parseInt(cfg['FASE5_CUENTA_ANTICIPO']);
  const cta430 = parseInt(cfg['FASE4_CUENTA_430']);
  const journalId = parseInt(cfg['FASE4_JOURNAL_ID']);
  const companyId = parseInt(cfg['ODOO_COMPANY_ID']);
  const nombreAgenciaDirecta = String(cfg['FASE5_NOMBRE_AGENCIA_DIRECTA'] || '').trim();
  if (!cuentaAnticipo) throw new Error('Falta FASE5_CUENTA_ANTICIPO en CONFIG.');
  if (!cta430) throw new Error('Falta FASE4_CUENTA_430 en CONFIG.');
  if (!journalId) throw new Error('Falta FASE4_JOURNAL_ID en CONFIG.');
  if (!companyId) throw new Error('Falta ODOO_COMPANY_ID en CONFIG.');
  if (!nombreAgenciaDirecta) throw new Error('Falta FASE5_NOMBRE_AGENCIA_DIRECTA en CONFIG (ej. "Ibiza Rocks Direct").');

  const ref = `MEWS-COB5/${fecha}`;
  const existente = odooExec(cfg, uid, 'account.move', 'search_read',
    [[['ref', '=', ref], ['journal_id', '=', journalId]]], { fields: ['id'], limit: 1 });
  if (existente.length > 0) {
    return { mensaje: `Ya existe un asiento de Fase 5 para ${fecha} (id ${existente[0].id}), no se duplica.` };
  }

  // Cruzar contra FACTURAS: solo se consume anticipo cuando la agencia
  // de la reserva (columna 'agencia', viene de RESERVAS/Reservations)
  // es exactamente la agencia directa configurada (ej. "Ibiza Rocks
  // Direct") — NO "cualquier bill sin NIF", que también capturaría
  // otros casos (ej. Ecotasas sueltas) que no tienen nada que ver.
  const factData = wsFact.getDataRange().getValues();
  const facturaPorBill = {};
  for (let i = 1; i < factData.length; i++) {
    facturaPorBill[String(factData[i][H_FACT.indexOf('bill_mews')]).trim()] = {
      estado: String(factData[i][H_FACT.indexOf('estado')]).trim(),
      invoiceId: factData[i][H_FACT.indexOf('odoo_invoice_id')],
      invoiceName: factData[i][H_FACT.indexOf('bill_odoo')],
      agencia: String(factData[i][H_FACT.indexOf('agencia')]).trim(),
    };
  }

  const porBillDirecto = {};
  for (const p of pagos) {
    const f = facturaPorBill[p.bill];
    if (!f || f.agencia.toLowerCase() !== nombreAgenciaDirecta.toLowerCase()) continue; // no encontrado, o no es la agencia directa → no se toca hoy
    if (!porBillDirecto[p.bill]) porBillDirecto[p.bill] = { total: 0, rowNums: [] };
    porBillDirecto[p.bill].total += p.amount;
    porBillDirecto[p.bill].rowNums.push(p.rowNum);
  }

  if (Object.keys(porBillDirecto).length === 0) {
    return { mensaje: `Ningún bill de "${nombreAgenciaDirecta}" que consumir en ${fecha} (el resto sigue pendiente de agencia o no aplica).` };
  }

  const billsProblema = [];
  const facturasAConciliar = [];
  let totalAnticipo = 0;

  for (const [bill, info] of Object.entries(porBillDirecto)) {
    const f = facturaPorBill[bill];
    if (f.estado !== 'CREADA' || !f.invoiceId) { billsProblema.push(`${bill}: estado "${f.estado}", no confirmada en Odoo`); continue; }

    const odoo = odooExec(cfg, uid, 'account.move', 'read', [[parseInt(f.invoiceId)]], { fields: ['state', 'amount_residual', 'partner_id'] });
    if (!odoo[0]) { billsProblema.push(`${bill}: factura no encontrada en Odoo`); continue; }
    if (odoo[0].state !== 'posted') { billsProblema.push(`${bill}: no confirmada en Odoo (estado "${odoo[0].state}")`); continue; }

    const residual = Math.round(odoo[0].amount_residual * 100) / 100;
    const importe = Math.round(Math.abs(info.total) * 100) / 100;

    // Aquí SÍ puede ser parcial — a diferencia de Fase 4, no tiene que
    // coincidir exacto con el residual, solo no puede ser MÁS de lo
    // que queda pendiente (eso sí sería una anomalía real).
    if (importe > residual + 0.01) {
      billsProblema.push(`${bill}: INV pide consumir ${importe}€ pero la factura solo tiene ${residual}€ pendiente (no cuadra)`);
      continue;
    }

    facturasAConciliar.push({
      bill, invoiceId: parseInt(f.invoiceId), invoiceName: f.invoiceName,
      partnerId: odoo[0].partner_id[0], importe, rowNums: info.rowNums,
    });
    totalAnticipo += importe;
  }

  if (billsProblema.length > 0) {
    throw new Error('Bills con problema (proceso bloqueado para hoy): ' + billsProblema.join(' | '));
  }

  const lineas = [
    { account_id: cuentaAnticipo, name: `Consumo anticipos Ibiza Rocks Direct — ${fecha}`, debit: Math.round(totalAnticipo * 100) / 100, credit: 0 },
  ];
  for (const f of facturasAConciliar) {
    lineas.push({ account_id: cta430, partner_id: f.partnerId, name: f.invoiceName, debit: 0, credit: f.importe });
  }

  let entryId;
  try {
    entryId = odooExec(cfg, uid, 'account.move', 'create', [{
      move_type: 'entry', journal_id: journalId, company_id: companyId,
      date: fecha, ref: ref, line_ids: lineas.map(l => [0, 0, l]),
    }], {});
  } catch (eCreate) {
    if (!esErrorSerializacionOdoo_(eCreate)) throw eCreate;
    const check = odooExec(cfg, uid, 'account.move', 'search_read',
      [[['ref', '=', ref], ['journal_id', '=', journalId]]], { fields: ['id'], limit: 1 });
    if (!check || check.length === 0) throw new Error(`create() falló de verdad: ${eCreate.message}`);
    entryId = check[0].id;
  }

  try {
    odooExec(cfg, uid, 'account.move', 'action_post', [[entryId]], {});
  } catch (ePost) {
    if (!esErrorSerializacionOdoo_(ePost)) {
      throw new Error(`Asiento creado (id ${entryId}) pero no se pudo validar: ${ePost.message}`);
    }
    const check = odooExec(cfg, uid, 'account.move', 'read', [[entryId]], { fields: ['state'] });
    if (!check[0] || check[0].state !== 'posted') {
      throw new Error(`Asiento creado (id ${entryId}) pero action_post() falló de verdad: ${ePost.message}`);
    }
  }

  const errores = conciliarFacturasFase4(cfg, uid, entryId, facturasAConciliar, cta430);

  for (const f of facturasAConciliar) {
    for (const rowNum of f.rowNums) {
      actualizarFila(wsPagos, rowNum, H_PAGOS, { estado: 'CONCILIADO_FASE5', notas: `Asiento ${entryId}` });
    }
  }

  const msg = errores.length === 0
    ? `Asiento creado y conciliado (id ${entryId}), ${facturasAConciliar.length} factura(s), ${totalAnticipo.toFixed(2)}€ consumidos.`
    : `Asiento creado (id ${entryId}) pero con errores de conciliación: ${errores.join(' | ')}`;

  return { mensaje: msg };
}
