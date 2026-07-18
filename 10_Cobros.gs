/**
 * ================================================================
 *  FASE 2 — COBROS (Payment Report de Mews → asiento contable diario)
 * ================================================================
 *  A diferencia de Fase 1, esto NO toca cliente ni factura para nada
 *  — es un asiento contable diario, agrupado por forma de pago
 *  ("Accounting category"), con una cuenta dedicada + una cuenta de
 *  contrapartida por cada categoría. Los cobros van en una línea, los
 *  reembolsos (importes negativos) en otra separada, sin netear.
 *
 *  CONFIG necesario, 3 claves por cada categoría de Mews que uses
 *  (ejemplo con las 6 vistas hasta ahora):
 *    COBRO_CUENTA_<CATEGORIA>          → cuenta dedicada (id Odoo)
 *    COBRO_CONTRAPARTIDA_<CATEGORIA>   → cuenta de contrapartida (id Odoo)
 *    COBRO_ETIQUETA_<CATEGORIA>        → texto descriptivo del apunte
 *  <CATEGORIA> = el texto de "Accounting category" normalizado
 *  (mayúsculas, espacios/guiones → _). Ej. "CASH - RECEPTION" →
 *  CASH_RECEPTION.
 *
 *  Más: FASE2_JOURNAL_ID → diario único donde se crea el asiento.
 *
 *  Si aparece una categoría sin las 3 claves en CONFIG, el proceso
 *  para con un error claro — no se inventa nada ni se salta en
 *  silencio (mismo criterio que "Serie X sin diario" en Fase 1).
 * ================================================================
 */

function procesarJsonsDeDriveCobros() {
  const ui = SpreadsheetApp.getUi();
  const cfg = getConfig();

  const inboxId = cfg['FOLDER_ID_INBOX'];
  const procesadosId = cfg['FOLDER_ID_PROCESADOS'];
  if (!inboxId) { ui.alert('❌ Falta FOLDER_ID_INBOX en CONFIG.'); return; }

  const inbox = DriveApp.getFolderById(inboxId);
  const pendientes = [];
  const iter = inbox.getFiles();
  while (iter.hasNext()) {
    const f = iter.next();
    if (f.getName().toUpperCase().includes('PAYMENT')) pendientes.push(f);
  }

  if (pendientes.length === 0) {
    ui.alert('📭 No hay JSONs de Payment report pendientes en la carpeta inbox.');
    return;
  }

  const confirmar = ui.alert(
    'Procesar Payment reports pendientes',
    `Se encontraron ${pendientes.length} archivo(s):\n\n` +
    pendientes.map(f => '• ' + f.getName()).join('\n') +
    '\n\n¿Procesar y crear los asientos?',
    ui.ButtonSet.YES_NO
  );
  if (confirmar !== ui.Button.YES) return;

  const carpetaProcesados = procesadosId ? DriveApp.getFolderById(procesadosId) : null;
  const resultados = [];

  for (const file of pendientes) {
    try {
      const raw = file.getBlob().getDataAsString();
      const data = JSON.parse(raw);
      const resultado = crearAsientoCobrosDelDia(data);
      resultados.push(`${file.getName()}: ${resultado.mensaje}`);

      if (carpetaProcesados) file.moveTo(carpetaProcesados);
      else file.setTrashed(true);
    } catch (err) {
      resultados.push(`❌ ${file.getName()}: ${err.message}`);
      Logger.log('ERROR procesando ' + file.getName() + ': ' + err.message);
    }
  }

  ui.alert('✅ Proceso completado\n\n' + resultados.join('\n'));
}

function crearAsientoCobrosDelDia(data) {
  const cfg = getConfig();
  const uid = getOdooUid(cfg);

  const fecha = extraerFechaReporteCobros(data);
  const ref = `MEWS-COB/${fecha}`;

  // Idempotencia: si ya existe un asiento con esta referencia, no se duplica.
  const existente = odooExec(cfg, uid, 'account.move', 'search_read',
    [[['ref', '=', ref], ['move_type', '=', 'entry']]],
    { fields: ['id'], limit: 1 }
  );
  if (existente.length > 0) {
    return { creado: false, mensaje: `Ya existe un asiento para ${fecha} (id ${existente[0].id}), no se duplica.` };
  }

  // 1. Extraer todos los pagos de "Cash payments" y "External payments"
  const pagos = [];
  for (const doc of data.Documents) {
    if (doc.Name !== 'Cash payments' && doc.Name !== 'External payments') continue;
    if (!Array.isArray(doc.Data) || doc.Data.length < 2) continue;

    const headers = doc.Data[0];
    const idxCat = headers.indexOf('Accounting category');
    const idxVal = headers.indexOf('Value');
    if (idxCat < 0 || idxVal < 0) continue;

    for (const row of doc.Data.slice(1)) {
      const categoria = String(row[idxCat] || '').trim();
      if (!categoria || categoria === 'Total') continue;
      const valor = parseFloat(row[idxVal]);
      if (isNaN(valor) || valor === 0) continue;
      pagos.push({ categoria, valor });
    }
  }

  if (pagos.length === 0) {
    return { creado: false, mensaje: `Sin pagos que registrar en el Payment report de ${fecha}.` };
  }

  // 2. Agrupar por (categoría, cobro/reembolso) — SIN netear entre sí
  const grupos = {};
  for (const p of pagos) {
    const esReembolso = p.valor < 0;
    const key = `${p.categoria}|||${esReembolso ? 'REEMBOLSO' : 'COBRO'}`;
    grupos[key] = (grupos[key] || 0) + p.valor;
  }

  // 3. Construir las líneas del asiento a partir de CONFIG
  // Las cuentas DEDICADAS van una línea por categoría (con su propia
  // etiqueta). Las CONTRAPARTIDAS se agrupan y suman por cuenta —
  // varias categorías pueden compartir la misma contrapartida (ej.
  // Paylands y Pikes Web ambas van a 438100), y en el asiento real
  // que usamos de referencia salían como una sola línea sumada, con
  // etiqueta genérica, no una por categoría.
  const lineas = [];
  const categoriasSinMapeo = new Set();
  const contrapartidas = {}; // key: `${contrapartidaId}|||${tipo}` → suma

  const etiquetaGenericaCobro = cfg['COBRO_ETIQUETA_GENERICA'] || 'Cobros MEWS del día';
  const etiquetaGenericaReembolso = cfg['COBRO_ETIQUETA_GENERICA_REEMBOLSO'] || 'Reembolsos MEWS del día';

  for (const [key, suma] of Object.entries(grupos)) {
    const [categoriaTexto, tipo] = key.split('|||');
    const catKey = normalizarCategoriaCobro(categoriaTexto);

    const cuentaId = parseInt(cfg[`COBRO_CUENTA_${catKey}`]);
    const contrapartidaId = parseInt(cfg[`COBRO_CONTRAPARTIDA_${catKey}`]);
    const etiqueta = cfg[`COBRO_ETIQUETA_${catKey}`] || categoriaTexto;

    if (!cuentaId || !contrapartidaId) {
      categoriasSinMapeo.add(`${categoriaTexto} (busca COBRO_CUENTA_${catKey} / COBRO_CONTRAPARTIDA_${catKey})`);
      continue;
    }

    const importe = Math.round(Math.abs(suma) * 100) / 100;

    if (tipo === 'COBRO') {
      lineas.push({ account_id: cuentaId, name: etiqueta, debit: importe, credit: 0 });
    } else {
      // Reembolso: mismo criterio que confirmaste — misma cuenta dedicada,
      // pero en el Haber, en línea aparte (no neteada con los cobros).
      lineas.push({ account_id: cuentaId, name: `${etiqueta} (reembolso)`, debit: 0, credit: importe });
    }

    const keyContra = `${contrapartidaId}|||${tipo}`;
    contrapartidas[keyContra] = (contrapartidas[keyContra] || 0) + importe;
  }

  if (categoriasSinMapeo.size > 0) {
    throw new Error('Categorías sin mapeo en CONFIG: ' + [...categoriasSinMapeo].join(' | '));
  }

  // Líneas de contrapartida: una por cuenta (sumada), no por categoría
  for (const [keyContra, importeSumado] of Object.entries(contrapartidas)) {
    const [contrapartidaIdTexto, tipo] = keyContra.split('|||');
    const contrapartidaId = parseInt(contrapartidaIdTexto);
    const importe = Math.round(importeSumado * 100) / 100;

    if (tipo === 'COBRO') {
      lineas.push({ account_id: contrapartidaId, name: etiquetaGenericaCobro, debit: 0, credit: importe });
    } else {
      lineas.push({ account_id: contrapartidaId, name: etiquetaGenericaReembolso, debit: importe, credit: 0 });
    }
  }

  // 4. Crear el asiento
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

  const totalDebe = lineas.reduce((s, l) => s + l.debit, 0);

  return {
    creado: true,
    mensaje: `Asiento creado (id ${moveId}) para ${fecha}: ${lineas.length} líneas, ${totalDebe.toFixed(2)}€. Recuerda confirmarlo en Odoo.`
  };
}

function normalizarCategoriaCobro(texto) {
  return String(texto).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function extraerFechaReporteCobros(data) {
  for (const doc of data.Documents) {
    if (doc.Name === 'Parameters' && Array.isArray(doc.Data)) {
      for (const row of doc.Data) {
        if (Array.isArray(row) && row[0] === 'Start') {
          return String(row[1]).split('T')[0];
        }
      }
    }
  }
  return new Date().toISOString().split('T')[0];
}
