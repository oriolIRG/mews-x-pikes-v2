/**
 * ================================================================
 *  FEES GATEWAY — comisión de Stripe/gateway sobre "Gateway Card Payment"
 * ================================================================
 *  Complementa a Fase 2 (Cobros), NO la sustituye ni la modifica.
 *  Fase 2 ya contabiliza el BRUTO ("Value") de cada categoría contra
 *  su cuenta puente. Pero el banco solo ingresa el NETO ("Payment")
 *  de las filas "Gateway Card Payment" — la diferencia es la comisión
 *  ("Adjusted total fee"), que si no se registra aparte se queda
 *  como saldo fantasma en la cuenta puente para siempre.
 *
 *  Esta fase lee el mismo Payment report ya usado por Fase 2 (mismo
 *  día, mismo criterio "Created" — el propio report ya es de un solo
 *  día), suma "Adjusted total fee" de todas las filas con
 *  Accounting category = "Gateway Card Payment", y hace un asiento
 *  simple de 2 líneas:
 *
 *    Debe   FEES_CUENTA_GASTO      → gasto de comisiones bancarias
 *    Haber  FEES_CUENTA_PUENTE     → misma cuenta puente de Gateway
 *                                    (COBRO_CUENTA_GATEWAY_CARD_PAYMENT)
 *
 *  Esto deja la cuenta puente en el neto real que se verá en banco;
 *  la comisión pasa a resultado como gasto.
 *
 *  CONFIG necesario:
 *    FEES_CUENTA_GASTO      → cuenta de gasto (id Odoo)  ej. 10101 (579006)
 *    FEES_CUENTA_PUENTE     → cuenta puente Gateway (id Odoo) ej. 10099 (579004)
 *    FEES_ETIQUETA          → texto descriptivo (opcional, default más abajo)
 *
 *  Más: usa FASE2_JOURNAL_ID y ODOO_COMPANY_ID, igual que Fase 2 —
 *  no hace falta un diario nuevo.
 *
 *  IMPORTANTE — integración con el flujo existente: esta función debe
 *  llamarse SOBRE EL MISMO `data` ya parseado que usa
 *  crearAsientoCobrosDelDia(data), dentro del mismo bucle de
 *  procesarJsonsDeDriveCobros(), ANTES de mover el archivo a la
 *  carpeta de procesados. Si se deja para un segundo paso, el
 *  archivo ya no estará en el inbox.
 * ================================================================
 */

function crearAsientoFeesGatewayDelDia(data) {
  const cfg = getConfig();
  const uid = getOdooUid(cfg);

  const fecha = extraerFechaReporteCobros(data); // mismo criterio que Fase 2
  const ref = `MEWS-FEES/${fecha}`;

  // Idempotencia: si ya existe un asiento con esta referencia, no se duplica.
  const existente = odooExec(cfg, uid, 'account.move', 'search_read',
    [[['ref', '=', ref], ['move_type', '=', 'entry']]],
    { fields: ['id'], limit: 1 }
  );
  if (existente.length > 0) {
    return { creado: false, mensaje: `Ya existe asiento de fees para ${fecha} (id ${existente[0].id}), no se duplica.` };
  }

  // 1. Sumar "Adjusted total fee" de todas las filas Gateway Card Payment,
  //    en el documento "Card payments".
  let totalFees = 0;
  let filasConFee = 0;

  for (const doc of data.Documents) {
    if (doc.Name !== 'Card payments') continue;
    if (!Array.isArray(doc.Data) || doc.Data.length < 2) continue;

    const headers = doc.Data[0];
    const idxCat = headers.indexOf('Accounting category');
    const idxFee = headers.indexOf('Adjusted total fee');
    if (idxCat < 0 || idxFee < 0) continue;

    for (const row of doc.Data.slice(1)) {
      if (!row || row[0] === 'Total') continue;
      const categoria = String(row[idxCat] || '').trim();
      if (categoria !== 'Gateway Card Payment') continue;

      const fee = parseFloat(row[idxFee]);
      if (isNaN(fee) || fee === 0) continue;

      totalFees += fee;
      filasConFee++;
    }
  }

  if (filasConFee === 0) {
    return { creado: false, mensaje: `Sin fees de Gateway Card Payment que registrar en el Payment report de ${fecha}.` };
  }

  // 2. Leer CONFIG de las 2 cuentas
  const cuentaGasto = parseInt(cfg['FEES_CUENTA_GASTO']);
  const cuentaPuente = parseInt(cfg['FEES_CUENTA_PUENTE']);
  const etiqueta = cfg['FEES_ETIQUETA'] || 'Comisiones Gateway (Stripe)';

  if (!cuentaGasto || !cuentaPuente) {
    throw new Error('Falta FEES_CUENTA_GASTO / FEES_CUENTA_PUENTE en CONFIG.');
  }

  const importe = Math.round(Math.abs(totalFees) * 100) / 100;

  const lineas = [
    { account_id: cuentaGasto, name: etiqueta, debit: importe, credit: 0 },
    { account_id: cuentaPuente, name: etiqueta, debit: 0, credit: importe },
  ];

  // 3. Crear el asiento (mismo diario y compañía que Fase 2)
  const journalId = parseInt(cfg['FASE2_JOURNAL_ID']);
  if (!journalId) throw new Error('Falta FASE2_JOURNAL_ID en CONFIG.');

  const companyId = parseInt(cfg['ODOO_COMPANY_ID']);
  if (!companyId) throw new Error('Falta ODOO_COMPANY_ID en CONFIG.');

  const moveId = odooExec(cfg, uid, 'account.move', 'create', [{
    journal_id: journalId,
    company_id: companyId,
    move_type: 'entry',
    date: fecha,
    ref: ref,
    line_ids: lineas.map(l => [0, 0, l]),
  }], {});

  return {
    creado: true,
    mensaje: `Asiento de fees creado (id ${moveId}) para ${fecha}: ${filasConFee} pagos, ${importe.toFixed(2)}€ de comisión. Recuerda confirmarlo en Odoo.`
  };
}