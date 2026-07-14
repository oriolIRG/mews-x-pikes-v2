/**
 * ================================================================
 *  LIMPIEZA DE UN SOLO USO — no forma parte del proyecto permanente
 * ================================================================
 *  Mueve a la papelera todos los archivos MEWS_RESERVATIONS_*.json
 *  de la carpeta inbox (FOLDER_ID_INBOX en CONFIG). Ya no hacen
 *  falta: con el doPost nuevo, Reservations se procesa al vuelo y
 *  nunca se guarda como archivo.
 *
 *  CÓMO USARLO:
 *   1. Pega esta función en cualquier archivo del proyecto (o crea
 *      uno temporal, ej. "99_Limpieza.gs").
 *   2. En el desplegable de funciones de arriba, selecciona
 *      "limpiarReservationsAntiguos" y dale a ▶ Ejecutar.
 *   3. Autoriza permisos de Drive si te lo pide.
 *   4. Te sale un aviso con cuántos archivos borró y cuántos MB
 *      liberó.
 *   5. Cuando termines, borra esta función/archivo — es de un solo uso.
 *
 *  Los archivos van a la papelera de Drive, no se destruyen al
 *  instante — si te equivocas, se pueden restaurar durante 30 días.
 * ================================================================
 */
function limpiarReservationsAntiguos() {
  const cfg = getConfig();
  const folderId = cfg['FOLDER_ID_INBOX'];
  if (!folderId) {
    SpreadsheetApp.getUi().alert('❌ Falta FOLDER_ID_INBOX en CONFIG.');
    return;
  }

  const folder = DriveApp.getFolderById(folderId);
  const files = folder.getFiles();

  let borrados = 0;
  let bytesLiberados = 0;
  const ejemplos = [];

  while (files.hasNext()) {
    const f = files.next();
    const nombre = f.getName();
    if (nombre.toUpperCase().includes('RESERVATIONS')) {
      bytesLiberados += f.getSize();
      if (ejemplos.length < 5) ejemplos.push(nombre);
      f.setTrashed(true);
      borrados++;
    }
  }

  const mbLiberados = (bytesLiberados / (1024 * 1024)).toFixed(1);

  SpreadsheetApp.getUi().alert(
    '🧹 Limpieza completada\n\n' +
    `• Archivos movidos a la papelera: ${borrados}\n` +
    `• Espacio liberado: ~${mbLiberados} MB\n\n` +
    (ejemplos.length > 0 ? 'Ejemplos:\n' + ejemplos.join('\n') : 'No había ninguno que limpiar.') +
    '\n\n(Están en la papelera de Drive, recuperables 30 días.)'
  );
}
