/**
 * ================================================================
 *  MEWS → ODOO  |  Proyecto nuevo (arranque julio 2026)
 *  Constantes centrales: nombres de pestañas y cabeceras
 * ================================================================
 *  Este archivo no tiene lógica, solo definiciones compartidas por
 *  todos los demás. Si cambias una columna, cámbiala aquí y ya
 *  se propaga a todo el proyecto.
 * ================================================================
 */

const TAB = {
  CONFIG:   'CONFIG',
  LOG:      'LOG_IMPORT',
  FACTURAS: 'FACTURAS',
  LINEAS:   'FACTURAS_LINEAS',
  CACHE:    'PARTNER_CACHE',
  HUECOS:   'HUECOS_NUMERACION',
  RESERVAS: 'RESERVAS',
  AGENCIAS: 'AGENCIAS',
  COMPANY_CACHE: 'COMPANY_CACHE',
};

const H_FACT = [
  'bill_mews', 'bill_odoo', 'serie', 'num_factura', 'fecha_cierre',
  'reservation_number', 'localizador_ota', 'agencia',
  'cliente_nif', 'cliente_nombre', 'partner_odoo_id',
  'num_lineas', 'importe_bruto', 'iva_rate',
  'continuidad', 'estado', 'odoo_invoice_id', 'fecha_procesado', 'notas'
];

const H_LIN = [
  'bill_mews', 'linea_num', 'mews_code', 'descripcion', 'vat_rate',
  'net', 'vat_amount', 'amount_bruto', 'odoo_product_id', 'odoo_tax_id', 'serie'
];

const H_LOG = ['timestamp', 'tipo_reporte', 'empresa', 'num_items', 'hash_md5', 'estado', 'notas'];
