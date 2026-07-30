/**
 * Cliente JSON-RPC con soporte Multi-Empresa
 * + Caché de UID: antes se hacía login (getUid) en CADA llamada a odooCall.
 *   El uid no cambia entre llamadas de una misma ejecución (ni durante horas),
 *   así que lo cacheamos:
 *     1) en una variable de script (gratis, dura toda la ejecución actual)
 *     2) en CacheService (dura 6h, se reutiliza también entre ejecuciones/triggers)
 */

let _ODOO_UID_CACHE = null;

function odooCall(config, model, method, args) {
  const endpoint = config.URL + "/jsonrpc";
  const uid = getUid(config);

  // PREPARAR CONTEXTO (Multi-Empresa)
  const kwargs = {};
  if (config.COMPANY_ID) {
    kwargs.context = {
      'allowed_company_ids': [config.COMPANY_ID]
    };
  }

  const payload = {
    "jsonrpc": "2.0",
    "method": "call",
    "params": {
      "service": "object",
      "method": "execute_kw",
      "args": [config.DB, uid, config.API_KEY, model, method, args, kwargs]
    },
    "id": new Date().getTime()
  };

  const options = {
    "method": "post",
    "contentType": "application/json",
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };

  let response, json;
  try {
    response = UrlFetchApp.fetch(endpoint, options);
    json = JSON.parse(response.getContentText());
  } catch (e) {
    throw new Error("Error de red o JSON: " + e.message);
  }

  if (json.error) {
    const msg = JSON.stringify(json.error);
    // Si el uid cacheado ya no es válido (caducó, cambiaron credenciales...),
    // invalidamos caché y reintentamos UNA vez con un login fresco.
    const looksLikeAuthIssue = msg.indexOf('AccessDenied') !== -1 || msg.indexOf('session_expired') !== -1;
    if (looksLikeAuthIssue) {
      _ODOO_UID_CACHE = null;
      CacheService.getScriptCache().remove(_uidCacheKey_(config));
      const retryUid = getUid(config);
      payload.params.args[1] = retryUid;
      payload.id = new Date().getTime();
      options.payload = JSON.stringify(payload);
      const retryResp = UrlFetchApp.fetch(endpoint, options);
      const retryJson = JSON.parse(retryResp.getContentText());
      if (retryJson.error) throw new Error("Odoo Error: " + JSON.stringify(retryJson.error));
      return retryJson.result;
    }
    throw new Error("Odoo Error: " + msg);
  }
  return json.result;
}

/**
 * Versión troceada de 'read' para no pasar miles de IDs en una sola llamada
 * (evita payloads gigantes / riesgo de timeout de Apps Script en resets completos).
 */
function odooReadBatched(config, model, ids, fields, batchSize) {
  batchSize = batchSize || 2000;
  const out = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    const chunk = ids.slice(i, i + batchSize);
    const result = odooCall(config, model, 'read', [chunk, fields]);
    out.push(...result);
  }
  return out;
}

function _uidCacheKey_(config) {
  return 'ODOO_UID_' + config.DB + '_' + config.USER;
}

function getUid(config) {
  if (_ODOO_UID_CACHE) return _ODOO_UID_CACHE;

  const cache = CacheService.getScriptCache();
  const cacheKey = _uidCacheKey_(config);
  const cached = cache.get(cacheKey);
  if (cached) {
    _ODOO_UID_CACHE = parseInt(cached, 10);
    return _ODOO_UID_CACHE;
  }

  const endpoint = config.URL + "/jsonrpc";
  const payload = {
    "jsonrpc": "2.0",
    "method": "call",
    "params": {
      "service": "common",
      "method": "login",
      "args": [config.DB, config.USER, config.API_KEY]
    },
    "id": 1
  };

  const response = UrlFetchApp.fetch(endpoint, {
    method: "post", contentType: "application/json", payload: JSON.stringify(payload)
  });

  const result = JSON.parse(response.getContentText()).result;
  if (!result) throw new Error("Login fallido. Revisa credenciales.");

  _ODOO_UID_CACHE = result;
  cache.put(cacheKey, String(result), 21600); // 6h
  return result;
}