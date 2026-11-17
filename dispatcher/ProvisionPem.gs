/* One-time, offline dispatcher key setup. No hosted execution is part of this source change. */
function provisionLionLogDispatcherPem() {
  let phase = 'before-write';
  try {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) throw new Error('Provisioning stopped.');
    try {
      const properties = PropertiesService.getScriptProperties();
      if (properties.getProperty('LIONLOG_DISPATCH_ACTIVATION')) throw new Error('Provisioning stopped.');
      const current = properties.getProperty('LIONLOG_APP_PRIVATE_KEY_PEM');
      if (typeof current !== 'string'
        || !/^-----BEGIN RSA PRIVATE KEY-----[\s\S]+-----END RSA PRIVATE KEY-----\s*$/.test(current)) {
        throw new Error('Provisioning stopped.');
      }
      const encoded = properties.getProperty('LIONLOG_APP_PRIVATE_KEY_PEM_STAGED_JSON');
      if (typeof encoded !== 'string') throw new Error('Provisioning stopped.');
      const pem = JSON.parse(encoded);
      if (typeof pem !== 'string'
        || !/^-----BEGIN PRIVATE KEY-----\r?\n(?:[A-Za-z0-9+/]{1,64}={0,2}\r?\n)+-----END PRIVATE KEY-----\r?\n?$/.test(pem)) {
        throw new Error('Provisioning stopped.');
      }
      // Google must accept the reconstructed key before the intended property is changed.
      const signature = Utilities.computeRsaSha256Signature('LionLog dispatcher PEM provisioning check', pem);
      if (!Array.isArray(signature) || signature.length === 0) throw new Error('Provisioning stopped.');
      phase = 'write-or-readback';
      properties.setProperty('LIONLOG_APP_PRIVATE_KEY_PEM', pem);
      if (properties.getProperty('LIONLOG_APP_PRIVATE_KEY_PEM') !== pem) {
        throw new Error('Provisioning outcome uncertain.');
      }
      return true;
    } finally {
      lock.releaseLock();
    }
  } catch {
    if (phase === 'write-or-readback') {
      throw new Error('Provisioning outcome uncertain; inspect before any retry.');
    }
    throw new Error('Provisioning stopped before key write.');
  }
}
