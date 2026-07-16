/**
 * ================================================================
 *  DIAGNÓSTICO DE UN SOLO USO — no forma parte del proyecto permanente
 * ================================================================
 *  Prueba crear un partner de test en Odoo en 3 pasos, cada uno
 *  añadiendo un campo más, para ver exactamente en qué paso empieza
 *  a fallar el "company crossover".
 *
 *  CÓMO USARLO:
 *   1. Pega esto en un archivo nuevo del proyecto de Facturas
 *      (ej. "99_Diagnostico.gs").
 *   2. Ejecuta "testCrearPartnerDiagnostico" desde el desplegable.
 *   3. Mira el resultado (aparece en un alert, y también en
 *      Ver → Registros / Ejecuciones si prefieres leerlo ahí).
 *   4. Borra en Odoo los partners de test que haya creado (busca
 *      "TEST DIAGNOSTICO BORRAR" en Contactos) y borra esta función.
 * ================================================================
 */
function testCrearPartnerDiagnostico() {
  const cfg = getConfig();
  const uid = getOdooUid(cfg);
  const companyId = parseInt(cfg['ODOO_COMPANY_ID']);
  const fiscalPositionId = parseInt(cfg['FISCAL_POSITION_ID']);

  const resultados = [];

  // Paso 1: solo nombre + compañía, SIN posición fiscal
  resultados.push(intentar('1. Solo company_id (sin fiscal_position_id)', {
    name: 'TEST DIAGNOSTICO BORRAR 1',
    is_company: false,
    customer_rank: 1,
    company_id: companyId,
  }));

  // Paso 2: + país (España)
  const esId = resolverPaisTest(cfg, uid, 'ES');
  resultados.push(intentar('2. + country_id (España)', {
    name: 'TEST DIAGNOSTICO BORRAR 2',
    is_company: false,
    customer_rank: 1,
    company_id: companyId,
    country_id: esId,
  }));

  // Paso 3: + fiscal_position_id (el sospechoso)
  resultados.push(intentar('3. + property_account_position_id (' + fiscalPositionId + ')', {
    name: 'TEST DIAGNOSTICO BORRAR 3',
    is_company: false,
    customer_rank: 1,
    company_id: companyId,
    country_id: esId,
    property_account_position_id: fiscalPositionId,
  }));

  SpreadsheetApp.getUi().alert(resultados.join('\n\n'));

  function intentar(etiqueta, partnerData) {
    try {
      const id = odooExec(cfg, uid, 'res.partner', 'create', [partnerData], {});
      return `✅ ${etiqueta}\n   → creado, id ${id}`;
    } catch (e) {
      return `❌ ${etiqueta}\n   → ${e.message}`;
    }
  }
}

function resolverPaisTest(cfg, uid, code) {
  try {
    const res = odooExec(cfg, uid, 'res.country', 'search_read', [[['code', '=', code]]], { fields: ['id'], limit: 1 });
    return res.length > 0 ? res[0].id : null;
  } catch (e) {
    return null;
  }
}

// Inspecciona un partner que SÍ funciona (5630) y compara su
// fiscal_position con la 233 que estamos usando — para ver si son
// literalmente la misma o si el bueno usa un id distinto que solo
// "se llama parecido".
function testInspeccionarPartner5630() {
  const cfg = getConfig();
  const uid = getOdooUid(cfg);

  const partner = odooExec(cfg, uid, 'res.partner', 'read', [[5630]], {
    fields: ['name', 'company_id', 'property_account_position_id', 'country_id', 'vat', 'is_company', 'customer_rank']
  });

  let msg = '📋 Partner 5630:\n' + JSON.stringify(partner[0], null, 2);

  if (partner[0] && partner[0].property_account_position_id) {
    const fpIdBueno = partner[0].property_account_position_id[0];
    const fpBueno = odooExec(cfg, uid, 'account.fiscal.position', 'read', [[fpIdBueno]], {
      fields: ['name', 'company_id', 'auto_apply', 'country_id', 'country_group_id', 'active']
    });
    msg += `\n\n✅ Fiscal position que usa 5630 (id ${fpIdBueno}):\n` + JSON.stringify(fpBueno[0], null, 2);

    const fp233 = odooExec(cfg, uid, 'account.fiscal.position', 'read', [[233]], {
      fields: ['name', 'company_id', 'auto_apply', 'country_id', 'country_group_id', 'active']
    });
    msg += `\n\n❌ Fiscal position 233 (la que estamos usando):\n` + JSON.stringify(fp233[0], null, 2);

    msg += fpIdBueno === 233
      ? '\n\n⚠️ MISMO ID — el partner 5630 usa literalmente la 233. Raro que a él le funcione.'
      : `\n\n👉 IDs DISTINTOS: 5630 usa la ${fpIdBueno}, nosotros la 233. Prueba a cambiar FISCAL_POSITION_ID a ${fpIdBueno}.`;
  } else {
    msg += '\n\n⚠️ El partner 5630 no tiene property_account_position_id puesto en absoluto.';
  }

  Logger.log(msg);
  SpreadsheetApp.getUi().alert(msg);
}

// Busca partners que SÍ pertenecen a Ibiza Rocks House (company_id=11)
// Y tienen alguna posición fiscal puesta — para comparar de verdad
// contra la 233, dentro de la misma compañía.
function testBuscarPartnersConFiscalPositionEnIRH() {
  const cfg = getConfig();
  const uid = getOdooUid(cfg);
  const companyId = parseInt(cfg['ODOO_COMPANY_ID']);

  const partners = odooExec(cfg, uid, 'res.partner', 'search_read',
    [[['company_id', '=', companyId], ['property_account_position_id', '!=', false]]],
    { fields: ['id', 'name', 'property_account_position_id'], limit: 10 }
  );

  if (partners.length === 0) {
    SpreadsheetApp.getUi().alert(
      `No hay NINGÚN partner en la compañía ${companyId} con property_account_position_id puesto.\n\n` +
      'Eso puede significar que nunca se ha creado uno con éxito — la posición fiscal 233 podría llevar rota desde siempre para esta compañía, no ser un fallo nuevo.'
    );
    return;
  }

  let msg = `Partners en la compañía ${companyId} con posición fiscal puesta:\n\n`;
  const fpIds = new Set();
  for (const p of partners) {
    msg += `• ${p.name} (id ${p.id}) → fiscal position: ${p.property_account_position_id[1]} (id ${p.property_account_position_id[0]})\n`;
    fpIds.add(p.property_account_position_id[0]);
  }
  msg += `\n👉 IDs de posición fiscal que SÍ funcionan aquí: ${[...fpIds].join(', ')}`;
  msg += fpIds.has(233) ? '\n\n⚠️ La 233 está entre ellas — raro que a nosotros nos falle.' : '\n\n(233 no está en esta lista — probablemente haya que usar una de las de arriba en vez de la 233.)';

  Logger.log(msg);
  SpreadsheetApp.getUi().alert(msg);
}

// Relee el partner 5630 pero esta vez FORZANDO el contexto de
// compañía explícitamente — property_account_position_id es un campo
// "company-dependent" en Odoo, así que sin contexto explícito puede
// estar leyendo (o validando, al crear) el valor de la compañía por
// defecto del usuario técnico, no de Ibiza Rocks House.
function testPartner5630ConContexto() {
  const cfg = getConfig();
  const uid = getOdooUid(cfg);
  const companyId = parseInt(cfg['ODOO_COMPANY_ID']);

  const partnerSinContexto = odooExec(cfg, uid, 'res.partner', 'read', [[5630]], {
    fields: ['name', 'property_account_position_id']
  });

  const partnerConContexto = odooExec(cfg, uid, 'res.partner', 'read', [[5630]], {
    fields: ['name', 'property_account_position_id'],
    context: { allowed_company_ids: [companyId], force_company: companyId, company_id: companyId }
  });

  const msg =
    `SIN contexto de compañía:\n${JSON.stringify(partnerSinContexto[0], null, 2)}\n\n` +
    `CON contexto (compañía ${companyId}):\n${JSON.stringify(partnerConContexto[0], null, 2)}`;

  Logger.log(msg);
  SpreadsheetApp.getUi().alert(msg);
}
