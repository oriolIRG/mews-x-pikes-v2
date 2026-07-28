/**
 * ================================================================
 *  PANEL WEB — capa fina sobre las funciones Core que ya existen
 * ================================================================
 *  No hay lógica de negocio nueva aquí — todo esto llama a las
 *  mismas funciones *Core que ya usa el menú de la hoja. Este
 *  archivo solo:
 *   1. Sirve el HTML del panel (doGet), con el nombre de la
 *      propiedad inyectado desde CONFIG (NOMBRE_PROPIEDAD) — así el
 *      mismo Panel.html sirve para Pikes e IRH sin tocar el HTML.
 *   2. Da forma "serializable" (objetos planos, nunca objetos de
 *      Drive/Sheets) a lo que necesita la interfaz, porque
 *      google.script.run no puede devolver ese tipo de objetos.
 *
 *  CONFIG nuevo:
 *    NOMBRE_PROPIEDAD → texto que se muestra en la cabecera del panel
 *                        (ej. "Pikes Ibiza", "Ibiza Rocks House")
 *
 *  DESPLIEGUE: Implementar → Nueva implementación → Aplicación web.
 *  Puede ser la misma URL que ya usas para el webhook (doPost) — Apps
 *  Script las distingue solas por el verbo HTTP (GET = panel, POST =
 *  webhook de Mews) — o una implementación aparte si prefieres URLs
 *  separadas para cada cosa.
 *
 *  RECORDATORIO que ya nos ha costado un buen rato hoy: guardar este
 *  archivo NO actualiza una Web App ya publicada. Hay que ir a
 *  Implementar → Gestionar implementaciones → editar la implementación
 *  de tipo "Aplicación web" → Versión: Nueva versión → Implementar.
 * ================================================================
 */

function doGet(e) {
  const cfg = getConfig();
  const nombrePropiedad = cfg['NOMBRE_PROPIEDAD'] || 'Mews';

  const template = HtmlService.createTemplateFromFile('Panel');
  template.nombrePropiedad = nombrePropiedad;

  return template.evaluate()
    .setTitle(`Mews → Odoo — ${nombrePropiedad}`)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ── Estado general, para pintar los semáforos del panel ────────────
function panelEstado() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cfg = getConfig();
  const estado = {};

  // Fase 1: JSONs pendientes en Drive
  try {
    const pendientes = listarJsonsPendientesFacturas();
    estado.jsonsFacturasPendientes = pendientes ? pendientes.length : 0;
  } catch (e) { estado.jsonsFacturasPendientes = null; estado.errorFacturasDrive = e.message; }

  // Fase 1: JSONs de Reservations pendientes en Drive
  try {
    const pendientesReservas = listarJsonsPendientesReservas();
    estado.jsonsReservasPendientes = pendientesReservas ? pendientesReservas.length : 0;
  } catch (e) { estado.jsonsReservasPendientes = null; }

  // Fase 1: estado de FACTURAS
  const wsFact = ss.getSheetByName(TAB.FACTURAS);
  let facturasPendientes = 0, facturasCreadas = 0, facturasError = 0;
  if (wsFact && wsFact.getLastRow() > 1) {
    const data = wsFact.getDataRange().getValues();
    const colEstado = H_FACT.indexOf('estado');
    for (let i = 1; i < data.length; i++) {
      const e = String(data[i][colEstado]).trim();
      if (e === 'PENDIENTE') facturasPendientes++;
      else if (e === 'CREADA') facturasCreadas++;
      else if (e === 'ERROR') facturasError++;
    }
  }
  estado.facturasPendientes = facturasPendientes;
  estado.facturasCreadas = facturasCreadas;
  estado.facturasError = facturasError;

  // Cuadre Gross
  const wsCuadre = ss.getSheetByName('CUADRE_GROSS');
  let discrepanciasPendientes = 0;
  if (wsCuadre && wsCuadre.getLastRow() > 1) {
    const data = wsCuadre.getDataRange().getValues();
    const colEstado = data[0].indexOf('estado');
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][colEstado]).trim() === 'PENDIENTE') discrepanciasPendientes++;
    }
  }
  estado.discrepanciasPendientes = discrepanciasPendientes;

  // Fase 2: JSONs de Payment pendientes en Drive
  try {
    const pendientesCobros = listarJsonsPendientesCobros();
    estado.jsonsCobrosPendientes = pendientesCobros ? pendientesCobros.length : 0;
  } catch (e) { estado.jsonsCobrosPendientes = null; estado.errorCobrosDrive = e.message; }

  // Fase 4: pagos PENDIENTE en PAGOS_CLOSED
  const wsPagos = ss.getSheetByName(TAB.PAGOS);
  let pagosPendientes = 0;
  if (wsPagos && wsPagos.getLastRow() > 1) {
    const data = wsPagos.getDataRange().getValues();
    const colEstado = H_PAGOS.indexOf('estado');
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][colEstado]).trim() === 'PENDIENTE') pagosPendientes++;
    }
  }
  estado.pagosPendientes = pagosPendientes;

  // Fase 5: CAMBIADO — ya no existe "PENDIENTE_FASE5". Ahora lo que
  // indica que hay trabajo pendiente en Fase 5 es: filas ya
  // "CONCILIADO" por Fase 4 con un código de FASE5_CODIGOS_ANTICIPO,
  // que todavía no se han agregado en un asiento de Fase 5 (es decir,
  // que agruparConciliadosAnticipoPorFecha() todavía las recogería).
  let pagosFase5Pendientes = 0;
  const codigosAnticipo = (cfg['FASE5_CODIGOS_ANTICIPO'] || '').split('|').map(s => s.trim()).filter(Boolean);
  if (wsPagos && wsPagos.getLastRow() > 1 && codigosAnticipo.length > 0) {
    const data = wsPagos.getDataRange().getValues();
    const colEstado = H_PAGOS.indexOf('estado');
    const colCode = H_PAGOS.indexOf('code');
    for (let i = 1; i < data.length; i++) {
      const est = String(data[i][colEstado]).trim();
      const code = String(data[i][colCode]).trim();
      if (est === 'CONCILIADO' && codigosAnticipo.includes(code)) pagosFase5Pendientes++;
    }
  }
  estado.pagosFase5Pendientes = pagosFase5Pendientes;

  return estado;
}

// ── Fase 1 ───────────────────────────────────────────────────────
function panelCargarReservas() {
  try {
    const pendientes = listarJsonsPendientesReservas();
    if (pendientes === null) return { ok: false, error: 'Falta FOLDER_ID_INBOX en CONFIG.' };
    if (pendientes.length === 0) return { ok: true, mensaje: 'No había ningún JSON de Reservations pendiente.', procesados: 0 };
    const r = procesarJsonsDeDriveReservasCore(pendientes);
    return Object.assign({ ok: true }, r);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function panelCargarFacturas() {
  try {
    const pendientes = listarJsonsPendientesFacturas();
    if (pendientes === null) return { ok: false, error: 'Falta FOLDER_ID_INBOX en CONFIG.' };
    if (pendientes.length === 0) return { ok: true, mensaje: 'No había ningún JSON pendiente.', procesados: 0, totalFacturas: 0 };
    const r = procesarJsonsDeDriveCore(pendientes);
    return Object.assign({ ok: true }, r);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function panelImportarFacturas() {
  try {
    const r = importarFacturasCore();
    return Object.assign({ ok: true }, r);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function panelComprobarCuadre() {
  try {
    const r = verificarCuadreConOdooCore();
    return Object.assign({ ok: true }, r);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function panelCorregirRedondeos() {
  try {
    const r = corregirRedondeosAutomaticamenteCore();
    return Object.assign({ ok: true }, r);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Fase 2 (ya incluye Fees Gateway dentro de cada resultado) ──────
function panelCargarCobros() {
  try {
    const pendientes = listarJsonsPendientesCobros();
    if (pendientes === null) return { ok: false, error: 'Falta FOLDER_ID_INBOX en CONFIG.' };
    if (pendientes.length === 0) return { ok: true, mensaje: 'No había ningún Payment report pendiente.', resultados: [] };
    const resultados = procesarJsonsDeDriveCobrosCore(pendientes);
    return { ok: true, resultados };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Fase 4 ──────────────────────────────────────────────────────
function panelSaldarFacturas() {
  try {
    const porFecha = agruparPagosPendientesPorFecha();
    if (porFecha === null) return { ok: true, mensaje: 'No hay pagos en PAGOS_CLOSED todavía.', resumen: [] };
    const fechas = Object.keys(porFecha).sort();
    if (fechas.length === 0) return { ok: true, mensaje: 'No hay pagos con estado PENDIENTE.', resumen: [] };
    const resumen = procesarSaldarFacturasCore(porFecha, fechas);
    return { ok: true, resumen };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Fase 5 — ACTUALIZADO al nuevo 13_Fase5.gs (genérico por
// FASE5_CODIGOS_ANTICIPO, ya no lee PENDIENTE_FASE5 ni cruza FACTURAS) ──
function panelConsumirAnticipos() {
  try {
    const porFecha = agruparConciliadosAnticipoPorFecha();
    const fechas = Object.keys(porFecha).sort();
    if (fechas.length === 0) return { ok: true, mensaje: 'No hay pagos conciliados pendientes de agregar en Fase 5.', resumen: [] };

    const cfg = getConfig();
    const uid = getOdooUid(cfg);
    const resumen = [];
    for (const fecha of fechas) {
      try {
        const r = consumirAnticiposDelDia(cfg, uid, fecha, porFecha[fecha]);
        resumen.push(`${fecha}: ${r.mensaje}`);
      } catch (e) {
        resumen.push(`${fecha}: ❌ ${e.message}`);
      }
    }
    return { ok: true, resumen };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}