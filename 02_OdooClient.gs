/**
 * ================================================================
 *  ODOO CLIENT — toda la comunicación XML-RPC vive aquí y solo aquí.
 *  Ninguna otra parte del proyecto debería construir XML a mano.
 * ================================================================
 */

function getOdooUid(cfg) {
  const props = PropertiesService.getScriptProperties();
  const uidKey = `uid_${cfg.odoo_db}`;
  const cached = props.getProperty(uidKey);
  if (cached) return parseInt(cached);

  const methodCall = XmlService.createElement('methodCall')
    .addContent(XmlService.createElement('methodName').setText('authenticate'))
    .addContent(XmlService.createElement('params')
      .addContent(odooParam(cfg.odoo_db))
      .addContent(odooParam(cfg.odoo_user))
      .addContent(odooParam(getApiKey()))
      .addContent(odooParam({}))
    );

  const payload = XmlService.getCompactFormat().format(XmlService.createDocument(methodCall));
  const resp = UrlFetchApp.fetch(`${cfg.odoo_url}/xmlrpc/2/common`, {
    method: 'post', contentType: 'text/xml', payload, muteHttpExceptions: true
  });

  const text = resp.getContentText();
  const match = text.match(/<int>(\d+)<\/int>/);
  const uid = match ? parseInt(match[1]) : null;

  if (!uid || isNaN(uid)) {
    const errMatch = text.match(/<string>([\s\S]*?)<\/string>/);
    throw new Error(
      'Autenticación Odoo fallida. ' +
      (errMatch ? errMatch[1].substring(0, 300) : 'Verifica odoo_user y ODOO_API_KEY.')
    );
  }

  props.setProperty(uidKey, String(uid));
  return uid;
}

function odooExec(cfg, uid, model, method, args, kwargs) {
  const methodCall = XmlService.createElement('methodCall')
    .addContent(XmlService.createElement('methodName').setText('execute_kw'))
    .addContent(XmlService.createElement('params')
      .addContent(odooParam(cfg.odoo_db))
      .addContent(odooParam(uid))
      .addContent(odooParam(getApiKey()))
      .addContent(odooParam(model))
      .addContent(odooParam(method))
      .addContent(odooParam(args))
      .addContent(odooParam(kwargs || {}))
    );

  const payload = XmlService.getCompactFormat().format(XmlService.createDocument(methodCall));
  const resp = UrlFetchApp.fetch(`${cfg.odoo_url}/xmlrpc/2/object`, {
    method: 'post', contentType: 'text/xml', payload, muteHttpExceptions: true
  });

  const text = resp.getContentText();

  if (text.includes('faultCode') || text.includes('<fault>')) {
    const allStrings = text.match(/<string>([\s\S]*?)<\/string>/g) || [];
    let errMsg = allStrings.length > 0
      ? allStrings[allStrings.length - 1].replace(/<\/?string>/g, '').substring(0, 400)
      : 'Error desconocido';
    throw new Error('Odoo error: ' + errMsg);
  }

  return parseOdooResponse(text);
}

// Nota: si en el futuro se usa 'reconcile' u otros métodos que en
// Odoo 19 a veces fallan al serializar la respuesta aunque la
// operación sí se ejecutó, NO uses odooExec() a pelo para eso —
// hay que capturar el error, comprobar si contiene 'dumps' / 'xmlrpc'
// / 'Traceback', y verificar el resultado real con una consulta
// posterior (reconciled = true) antes de dar el error por bueno.
// (Ver aprendizaje documentado para Fase 4 / conciliación.)

function odooParam(v) {
  return XmlService.createElement('param').addContent(odooValue(v));
}

function odooValue(d) {
  const val = XmlService.createElement('value');

  if (d === null || d === undefined) {
    val.addContent(XmlService.createElement('boolean').setText('0'));
  } else if (typeof d === 'boolean') {
    val.addContent(XmlService.createElement('boolean').setText(d ? '1' : '0'));
  } else if (typeof d === 'number') {
    val.addContent(XmlService.createElement(Number.isInteger(d) ? 'int' : 'double').setText(String(d)));
  } else if (typeof d === 'string') {
    val.addContent(XmlService.createElement('string').setText(d));
  } else if (Array.isArray(d)) {
    const dataEl = XmlService.createElement('data');
    d.forEach(item => dataEl.addContent(odooValue(item)));
    val.addContent(XmlService.createElement('array').addContent(dataEl));
  } else if (typeof d === 'object') {
    const struct = XmlService.createElement('struct');
    Object.entries(d).forEach(([k, v]) => {
      const member = XmlService.createElement('member');
      member.addContent(XmlService.createElement('name').setText(k));
      member.addContent(odooValue(v));
      struct.addContent(member);
    });
    val.addContent(struct);
  }

  return val;
}

function parseOdooResponse(text) {
  try {
    const doc = XmlService.parse(text);
    const root = doc.getRootElement();
    const paramsEl = root.getChild('params');
    if (!paramsEl) return null;
    const param = paramsEl.getChild('param');
    if (!param) return null;
    return parseOdooValue(param.getChild('value'));
  } catch (e) {
    const m = text.match(/<int>(\d+)<\/int>/) || text.match(/<i4>(\d+)<\/i4>/);
    if (m) return parseInt(m[1]);
    const b = text.match(/<boolean>(\d)<\/boolean>/);
    if (b) return b[1] === '1';
    return null;
  }
}

function parseOdooValue(valueEl) {
  if (!valueEl) return null;
  const children = valueEl.getChildren();
  if (children.length === 0) return valueEl.getText() || null;

  const type = children[0];
  const tag = type.getName();

  if (tag === 'int' || tag === 'i4') return parseInt(type.getText());
  if (tag === 'double') return parseFloat(type.getText());
  if (tag === 'boolean') return type.getText().trim() === '1';
  if (tag === 'string') return type.getText();
  if (tag === 'nil') return null;

  if (tag === 'array') {
    const dataEl = type.getChild('data');
    if (!dataEl) return [];
    return dataEl.getChildren('value').map(parseOdooValue);
  }

  if (tag === 'struct') {
    const obj = {};
    type.getChildren('member').forEach(member => {
      const name = member.getChildText('name');
      const val = member.getChild('value');
      if (name !== null) obj[name] = parseOdooValue(val);
    });
    return obj;
  }

  return type.getText();
}

function testConexionOdoo() {
  try {
    const cfg = getConfig();
    const uid = getOdooUid(cfg);
    const res = odooExec(cfg, uid, 'res.users', 'read', [[uid]], { fields: ['name', 'login'] });

    SpreadsheetApp.getUi().alert(
      '✅ Conexión OK\n\n' +
      'Usuario: ' + (res[0] ? res[0].name : '?') + '\n' +
      'Login:   ' + (res[0] ? res[0].login : '?') + '\n' +
      'UID:     ' + uid
    );
  } catch (e) {
    SpreadsheetApp.getUi().alert('❌ Error de conexión:\n\n' + e.message);
    Logger.log('testConexionOdoo ERROR: ' + e.message + '\n' + (e.stack || ''));
  }
}
