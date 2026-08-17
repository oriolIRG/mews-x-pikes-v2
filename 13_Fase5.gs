/**
 * ================================================================
 *  FASE 5 — CONSUMO DE ANTICIPOS (genérico, Pikes + Ibiza Rocks House)
 * ================================================================
 *  Archivo COMPARTIDO entre propiedades — el comportamiento cambia
 *  solo por CONFIG, no por código (mismo criterio que todo lo demás
 *  del proyecto).
 *
 *  Mecánica: para el día pedido, agrupa por CÓDIGO las filas de
 *  PAGOS_CLOSED con estado = "CONCILIADO" cuyo `code` esté en
 *  FASE5_CODIGOS_ANTICIPO (lista separada por "|"). Fase 4 ya las
 *  conciliò normalmente contra su cuenta puente de siempre
 *  (FASE4_CUENTA_<CODE>) — Fase 5 no concilia nada, solo reconoce en
 *  un asiento agregado que ese dinero no es nuevo: ya se había
 *  cobrado como anticipo en Fase 2, y ahora se está aplicando a
 *  facturas reales.
 *
 *  Un único asiento por día:
 *    Debe  FASE5_CUENTA_ANTICIPO (438)         → el total agregado
 *    Haber FASE4_CUENTA_<CODE> (una por cuenta, → sumado por cuenta,
 *          sumando códigos que compartan cuenta)   no por código
 *
 *  Por propiedad:
 *    Pikes → FASE5_CODIGOS_ANTICIPO = <los códigos que decidáis>
 *            (Paylands / Pikes Web / Gateway — no hay agencias, así
 *            que Fase 4 ya los concilia todos sin ningún filtro extra)
 *    IRH   → FASE5_CODIGOS_ANTICIPO = INV
 *            (Fase 4, con el cambio en 11_Saldar.gs, solo concilia el
 *            código INV cuando la agencia del bill es la directa
 *            configurada en FASE5_NOMBRE_AGENCIA_DIRECTA — cualquier
 *            otra agencia con ese mismo código se deja intacta, sigue
 *            "PENDIENTE", así que nunca llega aquí)
 *
 *  CONFIG necesario:
 *    FASE5_CODIGOS_ANTICIPO   → lista de códigos, separados por "|"
 *    FASE5_CUENTA_ANTICIPO    → cuenta 438 (Debe)
 *  Reutiliza FASE4_CUENTA_<CODE> (Haber, por código), FASE4_JOURNAL_ID
 *  y ODOO_COMPANY_ID — no hace falta ninguna cuenta nueva aparte de
 *  FASE5_CUENTA_ANTICIPO.
 *
 *  IMPORTANTE — orden: correr Fase 4 del día ANTES que Fase 5, porque
 *  Fase 5 lee lo que Fase 4 ya dejó marcado "CONCILIADO" ese mismo día.
 * ================================================================
 */

function procesarConsumoAnticipos() {
  const ui = SpreadsheetApp.getUi();

  const porFecha = agruparConciliadosAnticipoPorFecha();
  const fechas = Object.keys(porFecha).sort();
  if (fechas.length === 0) {
    ui.alert('No hay pagos conciliados con algún código de FASE5_CODIGOS_ANTICIPO pendientes de agregar en Fase 5.');
    return;
  }

  const confirmar = ui.alert(
    'Consumir anticipos (Fase 5)',
    `Se van a agregar ${fechas.length} día(s):\n` + fechas.map(f => '  • ' + f).join('\n') + '\n\n¿Continuar?',
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

// Sin UI — agrupa por fecha_cierre y por código las filas de
// PAGOS_CLOSED ya conciliadas por Fase 4 con algún código de la lista.
function agruparConciliadosAnticipoPorFecha() {
  const cfg = getConfig();
  const codigosAnticipo = (cfg['FASE5_CODIGOS_ANTICIPO'] || '').split('|').map(s => s.trim()).filter(Boolean);
  if (codigosAnticipo.length === 0) return {};

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const wsPagos = ss.getSheetByName(TAB.PAGOS);
  if (!wsPagos || wsPagos.getLastRow() < 2) return {};

  const data = wsPagos.getDataRange().getValues();
  const porFecha = {}; // fecha -> { porCodigo: {code: {total, rowNums}} }

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const estado = String(row[H_PAGOS.indexOf('estado')]).trim();
    const code = String(row[H_PAGOS.indexOf('code')]).trim();
    if (estado !== 'CONCILIADO' || !codigosAnticipo.includes(code)) continue;

    const fecha = formatFechaOdoo(row[H_PAGOS.indexOf('fecha_cierre')]);
    const amount = parseFloat(row[H_PAGOS.indexOf('amount')]);

    if (!porFecha[fecha]) porFecha[fecha] = {};
    if (!porFecha[fecha][code]) porFecha[fecha][code] = { total: 0, rowNums: [] };
    porFecha[fecha][code].total += amount;
    porFecha[fecha][code].rowNums.push(i + 1);
  }
  return porFecha;
}

function consumirAnticiposDelDia(cfg, uid, fecha, porCodigo) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const wsPagos = ss.getSheetByName(TAB.PAGOS);

  const cuentaAnticipo = parseInt(cfg['FASE5_CUENTA_ANTICIPO']);
  const journalId = parseInt(cfg['FASE4_JOURNAL_ID']);
  const companyId = parseInt(cfg['ODOO_COMPANY_ID']);
  if (!cuentaAnticipo) throw new Error('Falta FASE5_CUENTA_ANTICIPO en CONFIG.');
  if (!journalId) throw new Error('Falta FASE4_JOURNAL_ID en CONFIG.');
  if (!companyId) throw new Error('Falta ODOO_COMPANY_ID en CONFIG.');

  const ref = `MEWS-COB5/${fecha}`;
  const existente = odooExec(cfg, uid, 'account.move', 'search_read',
    [[['ref', '=', ref], ['journal_id', '=', journalId]]], { fields: ['id'], limit: 1 });
  if (existente.length > 0) {
    return { mensaje: `Ya existe un asiento de Fase 5 para ${fecha} (id ${existente[0].id}), no se duplica.` };
  }

  // Resolver cuenta puente por código, y SUMAR por cuenta (no por
  // código) — si dos códigos comparten cuenta puente (ej. Pikes, todo
  // contra la misma cuenta de control), sale una sola línea sumada.
  const porCuenta = {}; // account_id -> importe
  const codigosSinMapeo = [];
  let totalGeneral = 0;

  for (const [code, info] of Object.entries(porCodigo)) {
    const cuentaId = parseInt(cfg[`FASE4_CUENTA_${code}`]);
    if (!cuentaId) { codigosSinMapeo.push(code); continue; }
    porCuenta[cuentaId] = (porCuenta[cuentaId] || 0) + info.total;
    totalGeneral += info.total;
  }

  if (codigosSinMapeo.length > 0) {
    throw new Error('Códigos sin FASE4_CUENTA_<CODE> mapeada: ' + codigosSinMapeo.join(', '));
  }

  const importeTotal = Math.round(Math.abs(totalGeneral) * 100) / 100;
  if (importeTotal === 0) {
    return { mensaje: `Nada que consumir en ${fecha} (total 0€).` };
  }

  const lineas = [
    { account_id: cuentaAnticipo, name: `Consumo anticipos — ${fecha}`, debit: importeTotal, credit: 0 },
  ];
  for (const [cuentaIdTexto, importe] of Object.entries(porCuenta)) {
    lineas.push({
      account_id: parseInt(cuentaIdTexto),
      name: `Consumo anticipos — ${fecha}`,
      debit: 0,
      credit: Math.round(Math.abs(importe) * 100) / 100,
    });
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

  for (const info of Object.values(porCodigo)) {
    for (const rowNum of info.rowNums) {
      actualizarFila(wsPagos, rowNum, H_PAGOS, { estado: 'CONCILIADO_FASE5', notas: `Asiento ${entryId}` });
    }
  }

  return { mensaje: `Asiento creado (id ${entryId}), ${importeTotal.toFixed(2)}€ consumidos.` };
}