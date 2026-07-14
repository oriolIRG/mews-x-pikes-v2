/**
 * ================================================================
 *  PARTNERS — resolución de cliente en Odoo a partir del NIF/CIF
 * ================================================================
 *  Orden de resolución:
 *   1. ¿El CIF está en la pestaña AGENCIAS?           → esa id (siempre,
 *                                                        no depende del importe)
 *   2. ¿El CIF está en caché (PARTNER_CACHE)?          → esa id (siempre)
 *   3. ¿Existe en Odoo por NIF?                        → esa id (siempre, y se cachea)
 *   4. No existe todavía en Odoo:
 *        - factura > UMBRAL_CREACION_CLIENTE (CONFIG, por defecto 3000€)
 *          → se crea el cliente nuevo en Odoo
 *        - factura ≤ umbral → NO se crea; va a "Clientes Varios"
 *   5. No hay CIF en absoluto                         → partner "Varios"
 *
 *  El umbral SOLO aplica al paso 4 (creación de cliente nuevo). Si el
 *  cliente ya existe por cualquier otra vía (agencia, caché, o ya
 *  estaba en Odoo), se usa igual sin importar el importe.
 * ================================================================
 */

const UMBRAL_CREACION_CLIENTE_DEFECTO = 3000;

function resolverPartner(cfg, uid, agencia, nif, ownerNombre, ownerNif, fallbackId, importeFactura) {
  if (nif) {
    const agenciaId = buscarEnAgencias(nif);
    if (agenciaId) return { partnerId: agenciaId, origen: 'AGENCIA' };
  }

  const cifEfectivo = nif || ownerNif || '';
  const datosCache = cifEfectivo ? buscarEnCompanyCache(cifEfectivo) : null;
  const nombreEfectivo = (datosCache && datosCache.nombre)
    ? datosCache.nombre
    : (cifEfectivo ? 'Empresa ' + cifEfectivo : 'Cliente MEWS');

  if (cifEfectivo) {
    const cached = getCachedPartner(cifEfectivo);
    if (cached !== null) return { partnerId: cached, origen: 'CACHE' };

    const companyId = parseInt(cfg['ODOO_COMPANY_ID']);
    if (!companyId) {
      throw new Error('Falta ODOO_COMPANY_ID en CONFIG — necesario para aislar clientes por propiedad.');
    }

    // Solo se considera "ya existe" un partner compartido (sin compañía)
    // o uno privado de ESTA compañía. Uno privado de otra propiedad del
    // grupo no cuenta como encontrado.
    const res = odooExec(cfg, uid, 'res.partner', 'search_read',
      [[['vat', '=', cifEfectivo], ['active', '=', true], '|', ['company_id', '=', false], ['company_id', '=', companyId]]],
      { fields: ['id', 'name'], limit: 1 }
    );
    if (res.length > 0) {
      guardarPartnerCache(cifEfectivo, res[0].id, res[0].name, 'AUTO');
      return { partnerId: res[0].id, origen: 'ODOO_EXISTENTE' };
    }

    const umbral = parseFloat(cfg['UMBRAL_CREACION_CLIENTE']) || UMBRAL_CREACION_CLIENTE_DEFECTO;
    const importe = Math.abs(parseFloat(importeFactura) || 0);

    if (importe <= umbral) {
      // Por debajo del umbral: no se crea cliente nuevo, va a Varios.
      return {
        partnerId: parseInt(fallbackId),
        origen: 'VARIOS_BAJO_UMBRAL',
        detalle: `CIF ${cifEfectivo} no está en Odoo; factura ${importe.toFixed(2)}€ ≤ umbral ${umbral}€ → Clientes Varios`
      };
    }

    const newId = crearPartnerEnOdoo(cfg, uid, nombreEfectivo, cifEfectivo, companyId);
    if (newId) {
      guardarPartnerCache(cifEfectivo, newId, nombreEfectivo, 'CREADO_AUTO');
      return { partnerId: newId, origen: 'CREADO' };
    }

    // Tenía CIF y superaba el umbral, pero crearPartnerEnOdoo() falló
    // (ver Logger para el motivo). Cae a Varios, mismo destino pero
    // se distingue del caso "sin CIF" para no confundir al operador.
    return {
      partnerId: parseInt(fallbackId),
      origen: 'VARIOS_CREACION_FALLIDA',
      detalle: `CIF ${cifEfectivo}: falló la creación del cliente en Odoo → Clientes Varios`
    };
  }

  return {
    partnerId: parseInt(fallbackId),
    origen: 'VARIOS_SIN_NIF',
    detalle: 'Sin CIF/NIF en la factura → Clientes Varios'
  };
}

function buscarEnAgencias(cif) {
  if (!cif) return null;
  const ws = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB.AGENCIAS);
  if (!ws || ws.getLastRow() < 2) return null;

  const data = ws.getDataRange().getValues();
  const cifNorm = String(cif).trim().toUpperCase();

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1] || '').trim().toUpperCase() === cifNorm) {
      const id = parseInt(data[i][2]);
      return isNaN(id) ? null : id;
    }
  }
  return null;
}

function crearPartnerEnOdoo(cfg, uid, nombre, vat, companyId) {
  try {
    const datosCompletos = buscarEnCompanyCache(vat);
    const partnerData = { vat, is_company: true, customer_rank: 1, company_id: companyId };

    // Posición fiscal explícita (p.ej. "España Península"). La mayoría
    // de clientes son extranjeros, pero el servicio se presta en
    // España, así que el IVA debe ser el español normal — sin esto,
    // Odoo puede auto-detectar una posición fiscal extranjera/exenta
    // en cuanto alguien edite la factura a mano.
    const fiscalPositionId = parseInt(cfg['FISCAL_POSITION_ID']);
    if (fiscalPositionId) {
      partnerData.property_account_position_id = fiscalPositionId;
    } else {
      Logger.log('⚠️ FISCAL_POSITION_ID no está en CONFIG — cliente creado sin posición fiscal fija.');
    }

    if (datosCompletos) {
      partnerData.name = datosCompletos.nombre || nombre;
      if (datosCompletos.direccion) partnerData.street = datosCompletos.direccion;
      if (datosCompletos.email) partnerData.email = datosCompletos.email;
      if (datosCompletos.telefono) partnerData.phone = datosCompletos.telefono;
    } else {
      partnerData.name = nombre;
    }

    return odooExec(cfg, uid, 'res.partner', 'create', [partnerData], {});
  } catch (e) {
    Logger.log('ERROR creando partner ' + nombre + ': ' + e.message);
    return null;
  }
}

// COMPANY_CACHE es opcional: si existe, permite crear partners con
// dirección/email/teléfono completos en vez de solo nombre + CIF.
function buscarEnCompanyCache(cif) {
  if (!cif) return null;
  const ws = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB.COMPANY_CACHE);
  if (!ws || ws.getLastRow() < 2) return null;

  const data = ws.getDataRange().getValues();
  const cifNorm = String(cif).trim().toUpperCase();

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0] || '').trim().toUpperCase() === cifNorm) {
      return {
        nombre: String(data[i][1] || '').trim(),
        direccion: String(data[i][2] || '').trim(),
        email: String(data[i][3] || '').trim(),
        telefono: String(data[i][4] || '').trim(),
      };
    }
  }
  return null;
}

function getCachedPartner(nif) {
  const ws = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB.CACHE);
  if (!ws) return null;
  const data = ws.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === nif.trim()) {
      const id = parseInt(data[i][1]);
      return isNaN(id) ? null : id;
    }
  }
  return null;
}

function guardarPartnerCache(nif, partnerId, nombre, fuente) {
  const ws = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB.CACHE);
  if (!ws) return;
  ws.appendRow([nif, partnerId, nombre, ahora(), fuente || 'AUTO']);
}
