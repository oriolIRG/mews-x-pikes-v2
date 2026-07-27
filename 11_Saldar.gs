/**
 * ================================================================
 *  CAMBIO en 11_Saldar.gs — tratamiento de FASE4_CODIGOS_DIFERIR
 * ================================================================
 *  Antes: cualquier pago con código en FASE4_CODIGOS_DIFERIR (ej.
 *  "INV" en IRH) se difería SIEMPRE a Fase 5, sin mirar nada más.
 *
 *  Ahora se mira también la agencia del bill (columna `agencia` de
 *  FACTURAS):
 *
 *    código en FASE4_CODIGOS_DIFERIR + agencia == FASE5_NOMBRE_AGENCIA_DIRECTA
 *        → NO se difiere, se salda AQUÍ MISMO como cualquier otro
 *          código (contra FASE4_CUENTA_<CODE>) — es la reserva directa
 *          consumiendo su propio anticipo ya cobrado en Fase 2.
 *
 *    código en FASE4_CODIGOS_DIFERIR + otra agencia (o sin agencia)
 *        → se deja intacto, SIN tocar el estado (sigue "PENDIENTE").
 *          No es un anticipo, es "facturado a agencia, aún sin cobrar
 *          de verdad" — ya llegará su pago real (transferencia) como
 *          otro código en un futuro Closed report.
 *
 *  Ya NO existe el estado "PENDIENTE_FASE5": Fase 5 ahora solo agrega
 *  lo que Fase 4 ya concilió hoy bajo ese código + esa agencia, no
 *  gestiona nada por su cuenta.
 *
 *  Todo lo demás de la función (bills sin movimiento, validación de
 *  códigos, cruce por factura, creación/validación/conciliación del
 *  asiento) queda IDÉNTICO al original — solo cambia el bloque de
 *  "-1. Códigos a diferir", que se sustituye por lo de abajo, y hay
 *  que adelantar la lectura de FACTURAS a antes de ese bloque (antes
 *  se leía más tarde, en el paso 2).
 * ================================================================
 */

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

  // MOVIDO AQUÍ ARRIBA (antes se leía en el paso 2): necesitamos la
  // agencia de cada bill YA para decidir si un código diferido se
  // salda hoy o se deja intacto.
  const factData = wsFact.getDataRange().getValues();
  const facturaPorBill = {};
  for (let i = 1; i < factData.length; i++) {
    facturaPorBill[String(factData[i][H_FACT.indexOf('bill_mews')]).trim()] = {
      rowNum: i + 1,
      estado: String(factData[i][H_FACT.indexOf('estado')]).trim(),
      invoiceId: factData[i][H_FACT.indexOf('odoo_invoice_id')],
      invoiceName: factData[i][H_FACT.indexOf('bill_odoo')],
      agencia: String(factData[i][H_FACT.indexOf('agencia')]).trim(),
    };
  }

  // -1. Códigos a diferir (CONFIG) — CAMBIADO: ahora condicionado a la agencia.
  const codigosDiferir = (cfg['FASE4_CODIGOS_DIFERIR'] || '').split('|').map(s => s.trim()).filter(Boolean);
  const nombreAgenciaDirecta = String(cfg['FASE5_NOMBRE_AGENCIA_DIRECTA'] || '').trim().toLowerCase();

  const pagosSinDiferir = [];
  for (const p of pagosDelDia) {
    if (!codigosDiferir.includes(p.code)) {
      pagosSinDiferir.push(p);
      continue;
    }
    const f = facturaPorBill[p.bill];
    const agencia = f ? f.agencia.toLowerCase() : '';

    if (nombreAgenciaDirecta && agencia === nombreAgenciaDirecta) {
      // Agencia directa: consumo del propio anticipo — se salda AQUÍ
      // MISMO, como cualquier otro código. Ya no se difiere.
      pagosSinDiferir.push(p);
    }
    // Si no es la agencia directa (u otra agencia, o sin agencia):
    // no se hace nada — se deja tal cual, sigue "PENDIENTE". Ya NO se
    // marca "PENDIENTE_FASE5".
  }

  if (pagosSinDiferir.length === 0) {
    return { creado: false, mensaje: `Todos los pagos de ${fecha} eran de códigos diferidos sin resolver hoy (${codigosDiferir.join(', ')}) — nada que conciliar.` };
  }

  // A PARTIR DE AQUÍ: TODO IGUAL QUE EL ARCHIVO ORIGINAL
  // (paso 0: bills sin movimiento neto; paso 1: validar códigos;
  // paso 2: agrupar por factura — reutilizando facturaPorBill que ya
  // leímos arriba, no hace falta releer FACTURAS otra vez; paso 3-5:
  // construir/crear/validar/conciliar el asiento; marcar CONCILIADO).
  // No copio ese bloque aquí para no duplicar — es literalmente el
  // resto de la función tal como está en tu archivo actual, sin tocar
  // ni una línea.
}