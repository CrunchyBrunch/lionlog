/* One-time cleanup of the reconciled November 14, 2026 probe attempt. */
function clearLionLogReconciledProbeMarker() {
  const markerName = 'INERT_PROBE_POST_ATTEMPT';
  const keyName = 'LIONLOG_APP_PRIVATE_KEY_PEM';
  let deletionAttempted = false;
  try {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) throw new Error();
    try {
      const properties = PropertiesService.getScriptProperties();
      if (properties.getProperty('LIONLOG_DISPATCH_ACTIVATION')
        || properties.getProperty(markerName) !== '2026-11-14T15:27:59.677Z') {
        throw new Error();
      }
      const pem = properties.getProperty(keyName);
      if (typeof pem !== 'string'
        || !/^-----BEGIN PRIVATE KEY-----\r?\n(?:[A-Za-z0-9+/]{1,64}={0,2}\r?\n)+-----END PRIVATE KEY-----\r?\n?$/.test(pem)) {
        throw new Error();
      }

      deletionAttempted = true;
      properties.deleteProperty(markerName);
      if (properties.getProperty(markerName) !== null || properties.getProperty(keyName) !== pem) {
        throw new Error();
      }
    } finally {
      lock.releaseLock();
    }
    return true;
  } catch {
    if (deletionAttempted) {
      throw new Error('Marker cleanup outcome uncertain. Reconcile read-only before proceeding.');
    }
    throw new Error('Marker cleanup stopped before deletion.');
  }
}
