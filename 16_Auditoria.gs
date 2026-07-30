/**
 * ================================================================
 *  AUDITORÍA DE FACTURAS — sanity check de solo lectura contra Odoo
 * ================================================================
 *  Objetivo: que el equipo pueda comprobar de un vistazo, sin entrar
 *  en Odoo, que ninguna factura se ha quedado por el camino — y
 *  también detectar lo contrario: facturas que alguien canceló o
 *  dejó en borrador en Odoo directamente, sin que el Sheet lo sepa.
 *
 *  DISEÑO PENSADO PARA CORRER SOLO, DE NOCHE, SIN MOLESTAR:
 *   - Únicamente hace search_read sobre account.move. CERO create,
 *     CERO write, CERO post, CERO reconcile. Es literalmente
 *     imposible que esto toque un asiento o una factura real, pase
 *     lo que pase — es una fase de solo lectura, aislada del resto.
 *   - Por defecto audita solo una VENTANA RODANTE reciente
 *     (AUDITORIA_DIAS_ATRAS, default 30), no todo el histórico cada
 *     noche — así el trigger nocturno es rápido y no le pega un
 *     golpe grande a Odoo. Para una revisión completa puntual, usa
 *     auditarFacturasCompleto() aparte (sin límite de fechas).
 *   - Vive en su propia pestaña (AUDITORIA_FACTURAS) y su propio
 *     trigger de tiempo — no depende de ningún trigger ni de ninguna
 *     otra fase, y ninguna otra fase depende de esto.
 *
 *  CONFIG (todo opcional, con defaults razonables):
 *    AUDITORIA_DIAS_ATRAS       → ventana rodante en días (default 30)
 *    AUDITORIA_FECHA_DESDE      → si se rellena, fija el "desde" en
 *                                 vez de calcularlo por días atrás
 *    AUDITORIA_FECHA_HASTA      → si se rellena, fija el "hasta"
 *                                 (default: hoy)
 *
 *  Pestaña AUDITORIA_FACTURAS (se crea sola si no existe), columnas:
 *    odoo_id | serie_numero | fecha | importe_total | cliente |
 *    localizador | estado_odoo | ultima_revision
 * ================================================================
 */

const TAB_AUDITORIA = 'AUDITORIA_FACTURAS';
const H_AUDITORIA = ['odoo_id', 'serie_numero', 'fecha', 'importe_total', 'cliente', 'localizador', 'estado_odoo', 'ultima_revision'];

// Wrapper de menú — ventana rodante (rápido, el uso normal).
function auditarFacturas() {
  const ui = SpreadsheetApp.getUi();
  try {
    const r = auditarFacturasCore(null, null);
    ui.alert('✅ Auditoría completada\n\n' + r.mensaje);
  } catch (e) {
    ui.alert('❌ Error en auditoría: ' + e.message);
  }
}

// Wrapper de menú — histórico completo, sin límite de fechas. Para
// revisión puntual/inicial, no para el trigger nocturno.
function auditarFacturasCompleto() {
  const ui = SpreadsheetApp.getUi();
  const confirmar = ui.alert(
    'Auditoría completa (sin límite de fechas)',
    'Esto puede tardar bastante más que la auditoría normal si hay mucho histórico. ¿Continuar?',
    ui.ButtonSet.YES_NO
  );
  if (confirmar !== ui.Button.YES) return;
  try {
    const r = auditarFacturasCore('2000-01-01', null);
    ui.alert('✅ Auditoría completa terminada\n\n' + r.mensaje);
  } catch (e) {
    ui.alert('❌ Error en auditoría: ' + e.message);
  }
}

// Entrada del trigger nocturno — sin UI, sin confirmaciones.
function auditarFacturasTrigger() {
  try {
    const r = auditarFacturasCore(null, null);
    Logger.log('Auditoría nocturna: ' + r.mensaje);
  } catch (e) {
    Logger.log('ERROR auditoría nocturna: ' + e.message);
  }
}

// Sin UI — hace el trabajo real. desde/hasta en 'yyyy-MM-dd', o null
// para usar los defaults de CONFIG (ventana rodante).
function auditarFacturasCore(desde, hasta) {
  const cfg = getConfig();
  const uid = getOdooUid(cfg);
  const companyId = parseInt(cfg['ODOO_COMPANY_ID']);
  if (!companyId) throw new Error('Falta ODOO_COMPANY_ID en CONFIG.');

  if (!desde) {
    desde = cfg['AUDITORIA_FECHA_DESDE'] ||
      Utilities.formatDate(new Date(Date.now() - (parseInt(cfg['AUDITORIA_DIAS_ATRAS']) || 30) * 86400000),
        'Europe/Madrid', 'yyyy-MM-dd');
  }
  if (!hasta) {
    hasta = cfg['AUDITORIA_FECHA_HASTA'] || Utilities.formatDate(new Date(), 'Europe/Madrid', 'yyyy-MM-dd');
  }

  // SOLO LECTURA — search_read, nada más. Sin journal_id fijo a
  // propósito: las facturas pueden repartirse en varios diarios según
  // serie, así que se filtra por tipo de movimiento + compañía + rango
  // de fechas, no por un diario concreto.
  const facturas = odooExec(cfg, uid, 'account.move', 'search_read',
    [[
      ['move_type', 'in', ['out_invoice', 'out_refund']],
      ['company_id', '=', companyId],
      ['invoice_date', '>=', desde],
      ['invoice_date', '<=', hasta],
    ]],
    { fields: ['id', 'name', 'invoice_date', 'amount_total', 'partner_id', 'ref', 'state'], order: 'invoice_date asc' }
  );

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let ws = ss.getSheetByName(TAB_AUDITORIA);
  if (!ws) {
    ws = ss.insertSheet(TAB_AUDITORIA);
    ws.appendRow(H_AUDITORIA);
  }

  // Índice de filas existentes por odoo_id, para upsert sin recorrer
  // la hoja entera por cada factura.
  const data = ws.getLastRow() > 1 ? ws.getRange(2, 1, ws.getLastRow() - 1, H_AUDITORIA.length).getValues() : [];
  const filaPorId = {};
  for (let i = 0; i < data.length; i++) {
    filaPorId[String(data[i][0])] = i + 2; // +2: fila real en el Sheet (1-indexed + cabecera)
  }

  const ahora = Utilities.formatDate(new Date(), 'Europe/Madrid', 'yyyy-MM-dd HH:mm');
  let nuevas = 0, actualizadas = 0;

  for (const f of facturas) {
    const fila = [
      f.id,
      f.name,
      f.invoice_date,
      f.amount_total,
      Array.isArray(f.partner_id) ? f.partner_id[1] : '',
      f.ref || '',
      f.state,
      ahora,
    ];

    const rowNum = filaPorId[String(f.id)];
    if (rowNum) {
      ws.getRange(rowNum, 1, 1, H_AUDITORIA.length).setValues([fila]);
      actualizadas++;
    } else {
      ws.appendRow(fila);
      nuevas++;
    }
  }

  return {
    mensaje: `Rango ${desde} → ${hasta}: ${facturas.length} factura(s) en Odoo (${nuevas} nueva(s), ${actualizadas} actualizada(s) en el Sheet).`
  };
}

// Entrada del trigger mensual de barrido completo — sin UI. Existe
// PORQUE la ventana rodante diaria NUNCA vuelve a mirar una factura
// más antigua que AUDITORIA_DIAS_ATRAS: si alguien edita, cancela o
// borra en Odoo una factura de hace 3 meses, el trigger diario jamás
// se entera. Este barrido completo, aunque más espaciado, es el que
// detecta eso — recorre TODO el histórico cada vez que corre.
function auditarFacturasTriggerCompleto() {
  try {
    const r = auditarFacturasCore('2000-01-01', null);
    Logger.log('Auditoría completa (trigger mensual): ' + r.mensaje);
  } catch (e) {
    Logger.log('ERROR auditoría completa (trigger mensual): ' + e.message);
  }
}

// Instala AMBOS triggers de una vez — comprueba que no existan ya,
// para no duplicar ejecuciones si se llama dos veces por error.
function instalarTriggersAuditoria() {
  const ui = SpreadsheetApp.getUi();
  const triggers = ScriptApp.getProjectTriggers();
  const mensajes = [];

  const yaExisteDiario = triggers.some(t => t.getHandlerFunction() === 'auditarFacturasTrigger');
  if (yaExisteDiario) {
    mensajes.push('Diario: ya existía, no se duplica.');
  } else {
    ScriptApp.newTrigger('auditarFacturasTrigger')
      .timeBased()
      .everyDays(1)
      .atHour(3) // 03:00 hora del script (normalmente Europe/Madrid)
      .create();
    mensajes.push('Diario: instalado (cada noche ~03:00, ventana rodante de ' +
      (parseInt(getConfig()['AUDITORIA_DIAS_ATRAS']) || 30) + ' días).');
  }

  const yaExisteCompleto = triggers.some(t => t.getHandlerFunction() === 'auditarFacturasTriggerCompleto');
  if (yaExisteCompleto) {
    mensajes.push('Barrido completo: ya existía, no se duplica.');
  } else {
    // Día fijo del mes (no "cada 30 días" desde la instalación) para
    // que sea predecible y no vaya derivando de fecha con el tiempo.
    ScriptApp.newTrigger('auditarFacturasTriggerCompleto')
      .timeBased()
      .onMonthDay(1)
      .atHour(4) // hora distinta al diario, para que nunca coincidan
      .create();
    mensajes.push('Barrido completo: instalado (día 1 de cada mes, ~04:00, TODO el histórico).');
  }

  ui.alert('✅ Triggers de auditoría\n\n' + mensajes.join('\n'));
}