/* One-time recovery after Project Settings stripped the provisioned PEM's line breaks. */
function recoverLionLogDispatcherPem() {
  let phase = 'before-write';
  try {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) throw new Error('Recovery stopped.');
    try {
      const properties = PropertiesService.getScriptProperties();
      if (properties.getProperty('LIONLOG_DISPATCH_ACTIVATION')) throw new Error('Recovery stopped.');
      const encoded = properties.getProperty('LIONLOG_APP_PRIVATE_KEY_PEM_STAGED_JSON');
      if (typeof encoded !== 'string') throw new Error('Recovery stopped.');
      const pem = JSON.parse(encoded);
      if (typeof pem !== 'string'
        || !/^-----BEGIN PRIVATE KEY-----\r?\n(?:[A-Za-z0-9+/]{1,64}={0,2}\r?\n)+-----END PRIVATE KEY-----\r?\n?$/.test(pem)) {
        throw new Error('Recovery stopped.');
      }
      const current = properties.getProperty('LIONLOG_APP_PRIVATE_KEY_PEM');
      if (current !== pem.replace(/\r?\n/g, '')) throw new Error('Recovery stopped.');

      const signature = Utilities.computeRsaSha256Signature('LionLog dispatcher PEM recovery check', pem);
      if (!Array.isArray(signature) || signature.length === 0) throw new Error('Recovery stopped.');

      phase = 'write-or-delete';
      properties.setProperty('LIONLOG_APP_PRIVATE_KEY_PEM', pem);
      if (properties.getProperty('LIONLOG_APP_PRIVATE_KEY_PEM') !== pem) {
        throw new Error('Recovery outcome uncertain.');
      }
      properties.deleteProperty('LIONLOG_APP_PRIVATE_KEY_PEM_STAGED_JSON');
      if (properties.getProperty('LIONLOG_APP_PRIVATE_KEY_PEM') !== pem
        || properties.getProperty('LIONLOG_APP_PRIVATE_KEY_PEM_STAGED_JSON') !== null) {
        throw new Error('Recovery outcome uncertain.');
      }
      return true;
    } finally {
      lock.releaseLock();
    }
  } catch {
    if (phase === 'write-or-delete') {
      throw new Error('Recovery outcome uncertain; inspect before any retry.');
    }
    throw new Error('Recovery stopped before key write.');
  }
}
