/**
 * ================================================================
 *  PARTNERS — resolución de cliente en Odoo a partir del NIF/CIF
 * ================================================================
 *  Orden de resolución:
 *   1. ¿El CIF está en la pestaña AGENCIAS?           → esa id (siempre,
 *                                                        no depende del importe)
 *   2. ¿El CIF está en caché (PARTNER_CACHE)?          → esa id (siempre)
 *   3. Sin NIF de Mews: se consulta la hoja aparte de Huéspedes (por
 *      nombre exacto) — si tiene pasaporte, se usa como NIF efectivo
 *      para todo lo de abajo (mismo tratamiento que un NIF real).
 *   4. ¿Existe en Odoo por NIF/pasaporte?               → esa id (y se cachea)
 *   5. No existe todavía en Odoo:
 *        - factura > UMBRAL_CREACION_CLIENTE (CONFIG, por defecto 3000€)
 *          → se crea el cliente nuevo en Odoo (con país si venía del
 *            pasaporte)
 *        - factura ≤ umbral → NO se crea; va a "Clientes Varios"
 *   6. Sin NIF ni pasaporte, pero SÍ hay nombre (Owner) y supera el
 *      umbral → se intenta emparejar por nombre exacto en Odoo antes
 *      de crear un cliente nuevo (sin identificador, como persona)
 *   7. Nada de lo anterior, o no supera el umbral        → "Clientes Varios"
 *
 *  El umbral SOLO aplica a la creación de cliente nuevo. Si el
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

  // Sin NIF de ningún tipo: consultar la hoja aparte de Huéspedes por
  // nombre exacto. Si tiene pasaporte, se usa como NIF efectivo — así
  // reutiliza toda la lógica de abajo (agencia ya se comprobó, caché,
  // búsqueda en Odoo, creación con umbral) sin duplicar nada.
  let datosHuesped = null;
  let esPasaporte = false;
  let ownerNifEfectivo = ownerNif;
  if (!nif && !ownerNif && ownerNombre) {
    datosHuesped = buscarHuespedPorNombreExterno(cfg, ownerNombre);
    if (datosHuesped && datosHuesped.passport) {
      ownerNifEfectivo = datosHuesped.passport;
      esPasaporte = true;
    }
  }

  const cifEfectivo = nif || ownerNifEfectivo || '';
  const datosCache = cifEfectivo ? buscarEnCompanyCache(cifEfectivo) : null;
  const nombreEfectivo = (datosCache && datosCache.nombre)
    ? datosCache.nombre
    : (esPasaporte ? ownerNombre.trim() : (cifEfectivo ? 'Empresa ' + cifEfectivo : 'Cliente MEWS'));

  if (cifEfectivo) {
    const cached = getCachedPartner(cifEfectivo);
    if (cached !== null) return { partnerId: cached, origen: esPasaporte ? 'CACHE_PASAPORTE' : 'CACHE' };

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
      guardarPartnerCache(cifEfectivo, res[0].id, res[0].name, esPasaporte ? 'AUTO_PASAPORTE' : 'AUTO');
      return { partnerId: res[0].id, origen: esPasaporte ? 'ODOO_EXISTENTE_PASAPORTE' : 'ODOO_EXISTENTE' };
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

    const resultado = crearPartnerEnOdoo(cfg, uid, nombreEfectivo, cifEfectivo, companyId, {
      esPersona: esPasaporte,
      countryId: esPasaporte ? resolverCountryId(cfg, uid, datosHuesped.countryCode) : null,
    });
    if (resultado.id) {
      guardarPartnerCache(cifEfectivo, resultado.id, nombreEfectivo, esPasaporte ? 'CREADO_PASAPORTE' : 'CREADO_AUTO');
      return { partnerId: resultado.id, origen: esPasaporte ? 'CREADO_CON_PASAPORTE' : 'CREADO' };
    }

    // Tenía CIF y superaba el umbral, pero crearPartnerEnOdoo() falló.
    // Cae a Varios, mismo destino pero con el motivo real de Odoo en
    // notas, no un mensaje genérico.
    return {
      partnerId: parseInt(fallbackId),
      origen: 'VARIOS_CREACION_FALLIDA',
      detalle: `CIF ${cifEfectivo}: falló la creación del cliente en Odoo: ${resultado.error} → Clientes Varios`
    };
  }

  // Sin NIF: si la factura supera el umbral, se intenta emparejar por
  // nombre exacto (campo Owner de Mews) antes de rendirse a Varios.
  // Sin NIF no hay clave estable, así que esto es best-effort: un
  // espacio o acento distinto no lo va a encontrar. Se cachea por
  // nombre (prefijo NOMBRE:: para no chocar con claves de NIF reales)
  // para no repetir la búsqueda si el mismo huésped vuelve a superar
  // el umbral en otra factura.
  const nombreGuest = String(ownerNombre || '').trim();
  if (nombreGuest) {
    const companyId = parseInt(cfg['ODOO_COMPANY_ID']);
    const umbral = parseFloat(cfg['UMBRAL_CREACION_CLIENTE']) || UMBRAL_CREACION_CLIENTE_DEFECTO;
    const importe = Math.abs(parseFloat(importeFactura) || 0);

    if (companyId && importe > umbral) {
      const claveCache = `NOMBRE::${nombreGuest}`;
      const cachedPorNombre = getCachedPartner(claveCache);
      if (cachedPorNombre !== null) return { partnerId: cachedPorNombre, origen: 'CACHE_POR_NOMBRE' };

      const res = odooExec(cfg, uid, 'res.partner', 'search_read',
        [[['name', '=', nombreGuest], ['active', '=', true], '|', ['company_id', '=', false], ['company_id', '=', companyId]]],
        { fields: ['id', 'name'], limit: 1 }
      );
      if (res.length > 0) {
        guardarPartnerCache(claveCache, res[0].id, res[0].name, 'AUTO_NOMBRE');
        return { partnerId: res[0].id, origen: 'ODOO_EXISTENTE_POR_NOMBRE' };
      }

      try {
        const fiscalPositionId = parseInt(cfg['FISCAL_POSITION_ID']);
        const partnerData = { name: nombreGuest, is_company: false, customer_rank: 1, company_id: companyId };
        if (fiscalPositionId) partnerData.property_account_position_id = fiscalPositionId;
        const newId = odooExec(cfg, uid, 'res.partner', 'create', [partnerData], {});
        guardarPartnerCache(claveCache, newId, nombreGuest, 'CREADO_SIN_NIF');
        return {
          partnerId: newId,
          origen: 'CREADO_SIN_NIF',
          detalle: `Cliente creado SIN NIF (emparejado solo por nombre "${nombreGuest}") — factura ${importe.toFixed(2)}€ > umbral ${umbral}€. Revisar y añadir NIF si aparece más adelante.`
        };
      } catch (e) {
        Logger.log('ERROR creando partner sin NIF ' + nombreGuest + ': ' + e.message);
        return {
          partnerId: parseInt(fallbackId),
          origen: 'VARIOS_CREACION_FALLIDA_SIN_NIF',
          detalle: `Se intentó crear "${nombreGuest}" sin NIF pero Odoo dio error: ${e.message} → Clientes Varios`
        };
      }
    }

    // Tenía nombre, pero no se intentó nada por nombre: o no supera el
    // umbral, o falta ODOO_COMPANY_ID. Se deja constancia del motivo
    // real en vez del mensaje genérico de abajo — esto es justo lo
    // que costó diagnosticar la primera vez.
    return {
      partnerId: parseInt(fallbackId),
      origen: 'VARIOS_SIN_NIF_BAJO_UMBRAL',
      detalle: `Sin NIF; "${nombreGuest}" detectado pero factura ${importe.toFixed(2)}€ no supera el umbral ${umbral}€ (o falta ODOO_COMPANY_ID) → Clientes Varios`
    };
  }

  return {
    partnerId: parseInt(fallbackId),
    origen: 'VARIOS_SIN_NIF',
    detalle: 'Sin CIF/NIF y sin nombre de cliente en la factura → Clientes Varios'
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

function crearPartnerEnOdoo(cfg, uid, nombre, vat, companyId, opciones) {
  const esPersona = (opciones && opciones.esPersona) || false;
  const countryId = (opciones && opciones.countryId) || null;

  try {
    const datosCompletos = buscarEnCompanyCache(vat);
    const partnerData = { vat, is_company: !esPersona, customer_rank: 1, company_id: companyId };
    if (countryId) partnerData.country_id = countryId;

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

    const id = odooExec(cfg, uid, 'res.partner', 'create', [partnerData], {});
    return { id, error: null };
  } catch (e) {
    Logger.log('ERROR creando partner ' + nombre + ': ' + e.message);
    return { id: null, error: e.message };
  }
}

// ── Integración con la hoja aparte de Huéspedes (proyecto distinto) ─
// CONFIG: HUESPEDES_SHEET_ID → id de esa hoja de Google Sheets.
// Opcional: si no está configurado, esto simplemente no se usa (no
// rompe nada, solo no encuentra pasaporte/país para nadie).
function buscarHuespedPorNombreExterno(cfg, nombreCompleto) {
  const sheetId = cfg['HUESPEDES_SHEET_ID'];
  if (!sheetId) return null;

  const objetivo = normalizarNombre(nombreCompleto);
  if (!objetivo) return null;

  try {
    const ss = SpreadsheetApp.openById(sheetId);
    const ws = ss.getSheetByName('HUESPEDES');
    if (!ws || ws.getLastRow() < 2) return null;

    const data = ws.getDataRange().getValues();
    const headers = data[0];
    const colNombre = headers.indexOf('nombre_completo');
    const colPassport = headers.indexOf('passport_number');
    const colCountry = headers.indexOf('country');
    const colCountryCode = headers.indexOf('country_code');

    for (let i = 1; i < data.length; i++) {
      if (normalizarNombre(data[i][colNombre]) === objetivo) {
        const passport = String(data[i][colPassport] || '').trim();
        if (!passport) return null; // encontrado, pero sin pasaporte registrado
        return {
          passport,
          country: String(data[i][colCountry] || '').trim(),
          countryCode: String(data[i][colCountryCode] || '').trim(),
        };
      }
    }
    return null;
  } catch (e) {
    Logger.log('ERROR consultando hoja de Huéspedes: ' + e.message);
    return null;
  }
}

function resolverCountryId(cfg, uid, countryCode) {
  if (!countryCode) return null;
  try {
    const res = odooExec(cfg, uid, 'res.country', 'search_read',
      [[['code', '=', countryCode.toUpperCase()]]], { fields: ['id'], limit: 1 });
    return res.length > 0 ? res[0].id : null;
  } catch (e) {
    Logger.log('ERROR buscando país ' + countryCode + ': ' + e.message);
    return null;
  }
}

// Misma normalización que en el proyecto de Huéspedes — si se cambia
// aquí, cambiar también allí para que sigan comparando igual.
function normalizarNombre(s) {
  return String(s || '')
    .trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .toUpperCase();
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
