/**
 * ================================================================
 *  MENÚ — lo único que ve el equipo al abrir la hoja
 * ================================================================
 *  De momento solo hay Facturas (lo demás se añade fase a fase).
 *  Nombres en lenguaje llano a propósito: el equipo no necesita
 *  saber que esto internamente es "Fase 1".
 * ================================================================
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();

  ui.createMenu('🏨 Mews → Odoo')
    .addItem('1️⃣ Cargar facturas nuevas de Mews', 'procesarJsonsDeDrive')
    .addItem('2️⃣ Enviar facturas a Odoo', 'importarFacturas')
    .addSeparator()
    .addItem('💶 Cargar cobros de Mews (Fase 2)', 'procesarJsonsDeDriveCobros')
    .addSeparator()
    .addItem('🔍 Comprobar numeración', 'verificarContinuidad')
    .addItem('⚖️ Repasar cuadre Gross (facturas antiguas)', 'verificarCuadreConOdoo')
    .addItem('🧮 Corregir redondeos pequeños', 'corregirRedondeosAutomaticamente')
    .addItem('🔄 Reintentar facturas con error', 'reprocesarErrores')
    .addSeparator()
    .addItem('⚙️ Comprobar configuración', 'verificarConfig')
    .addItem('🔌 Probar conexión con Odoo', 'testConexionOdoo')
    .addToUi();
}
