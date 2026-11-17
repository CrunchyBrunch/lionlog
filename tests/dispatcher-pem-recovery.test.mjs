import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../dispatcher/RecoverPem.gs', import.meta.url), 'utf8');
const target = 'LIONLOG_APP_PRIVATE_KEY_PEM';
const staged = 'LIONLOG_APP_PRIVATE_KEY_PEM_STAGED_JSON';
const marker = 'INERT_PROBE_POST_ATTEMPT';
const secretError = 'SECRET_CAUSE_MUST_NOT_ESCAPE';

function fixture({ current, encoded, activation = '', signFailure = false, emptySignature = false,
  writeFailure = null, deleteFailure = null, readbackFailure = null, lockAvailable = true,
  omitStaged = false, staleStagedReadback = false } = {}) {
  const { privateKey: pem, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const flattened = pem.replace(/\r?\n/g, '');
  const values = new Map([
    [target, current ?? flattened], [staged, encoded ?? JSON.stringify(pem)],
    [marker, '2026-11-14T15:27:59.677Z'],
    ['lionlog-dispatch-claim:2026-11-14', 'retained claim'],
    ['LIONLOG_DISPATCH_ACTIVATION', activation], ['UNRELATED', 'preserved'],
  ]);
  if (omitStaged) values.delete(staged);
  let writes = 0;
  let deletes = 0;
  let signing = 0;
  let targetReadsAfterWrite = 0;
  let locked = false;
  const context = {
    Error, JSON, Array,
    LockService: { getScriptLock: () => ({
      tryLock: () => { if (!lockAvailable) return false; locked = true; return true; },
      releaseLock: () => { assert.equal(locked, true); locked = false; },
    }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => {
        if (key === staged && deletes && staleStagedReadback) return JSON.stringify(pem);
        if (key === target && writes) {
          targetReadsAfterWrite += 1;
          if (readbackFailure === targetReadsAfterWrite) throw Error(secretError);
          if (readbackFailure === `mismatch-${targetReadsAfterWrite}`) return 'unexpected target';
        }
        return values.get(key) ?? null;
      },
      setProperty: (key, value) => {
        assert.equal(key, target);
        assert.equal(locked, true);
        writes += 1;
        if (writeFailure === 'before') throw Error(secretError);
        values.set(key, value);
        if (writeFailure === 'after') throw Error(secretError);
      },
      deleteProperty: key => {
        assert.equal(key, staged, 'only the temporary property may be deleted');
        assert.equal(locked, true);
        deletes += 1;
        if (deleteFailure === 'before') throw Error(secretError);
        values.delete(key);
        if (deleteFailure === 'after') throw Error(secretError);
      },
    }) },
    Utilities: { computeRsaSha256Signature: (message, key) => {
      signing += 1;
      if (signFailure) throw Error(secretError);
      if (emptySignature) return [];
      const signature = sign('RSA-SHA256', Buffer.from(message), key);
      assert.ok(verify('RSA-SHA256', Buffer.from(message), publicKey, signature));
      return [...signature];
    } },
    UrlFetchApp: { fetch: () => { throw Error('unexpected network request'); } },
    ScriptApp: { newTrigger: () => { throw Error('unexpected trigger'); } },
    console: { log: () => { throw Error('unexpected log'); } },
  };
  vm.runInNewContext(source, context);
  return { run: () => vm.runInNewContext('recoverLionLogDispatcherPem()', context),
    values, pem, flattened, activation, writes: () => writes, deletes: () => deletes, signing: () => signing,
    locked: () => locked };
}

function failsSafely(f, pattern) {
  assert.throws(f.run, error => pattern.test(error.message)
    && !error.message.includes(secretError) && !error.message.includes('PRIVATE KEY'));
  assert.equal(f.locked(), false);
}

function preservesUnrelated(f) {
  assert.equal(f.values.get(marker), '2026-11-14T15:27:59.677Z');
  assert.equal(f.values.get('lionlog-dispatch-claim:2026-11-14'), 'retained claim');
  assert.equal(f.values.get('LIONLOG_DISPATCH_ACTIVATION'), f.activation);
  assert.equal(f.values.get('UNRELATED'), 'preserved');
}

test('recovers exact multiline PEM and deletes only staging under one lock', () => {
  const f = fixture();
  assert.equal(f.run(), true);
  assert.equal(f.signing(), 1);
  assert.equal(f.writes(), 1);
  assert.equal(f.deletes(), 1);
  assert.equal(f.values.get(target), f.pem);
  assert.equal(f.values.has(staged), false);
  assert.equal(f.locked(), false);
  preservesUnrelated(f);
  failsSafely(f, /before key write/);
  assert.equal(f.writes(), 1);
  assert.equal(f.deletes(), 1);
});

test('wrong target, invalid staging, activation and unavailable lock stop before signing or mutation', () => {
  for (const options of [
    { current: 'other key' }, { current: '-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----' },
    { encoded: '{' }, { encoded: 'null' }, { encoded: JSON.stringify('invalid') },
    { omitStaged: true },
    { activation: 'ENABLE_LIONLOG_EXTERNAL_DISPATCH' }, { lockAvailable: false },
  ]) {
    const f = fixture(options);
    failsSafely(f, /before key write/);
    assert.equal(f.signing(), 0);
    assert.equal(f.writes(), 0);
    assert.equal(f.deletes(), 0);
    preservesUnrelated(f);
  }
});

test('Google signer failure or empty result stops before mutation', () => {
  for (const options of [{ signFailure: true }, { emptySignature: true }]) {
    const f = fixture(options);
    failsSafely(f, /before key write/);
    assert.equal(f.signing(), 1);
    assert.equal(f.writes(), 0);
    assert.equal(f.deletes(), 0);
    assert.equal(f.values.get(target), f.flattened);
    preservesUnrelated(f);
  }
});

test('write exceptions and first readback failures are uncertain without cleanup', () => {
  for (const options of [
    { writeFailure: 'before' }, { writeFailure: 'after' },
    { readbackFailure: 1 }, { readbackFailure: 'mismatch-1' },
  ]) {
    const f = fixture(options);
    failsSafely(f, /outcome uncertain/);
    assert.equal(f.writes(), 1);
    assert.equal(f.deletes(), 0);
    assert.equal(f.values.has(staged), true);
    preservesUnrelated(f);
  }
});

test('deletion failures after write remain uncertain and do not retry', () => {
  for (const deleteFailure of ['before', 'after']) {
    const f = fixture({ deleteFailure });
    failsSafely(f, /outcome uncertain/);
    assert.equal(f.writes(), 1);
    assert.equal(f.deletes(), 1);
    assert.equal(f.values.get(target), f.pem);
    assert.equal(f.values.has(staged), deleteFailure === 'before');
    failsSafely(f, /before key write/);
    assert.equal(f.writes(), 1);
    assert.equal(f.deletes(), 1);
    preservesUnrelated(f);
  }
});

test('post-deletion target mismatch or exception is uncertain', () => {
  for (const options of [{ readbackFailure: 2 }, { readbackFailure: 'mismatch-2' },
    { staleStagedReadback: true }]) {
    const f = fixture(options);
    failsSafely(f, /outcome uncertain/);
    assert.equal(f.writes(), 1);
    assert.equal(f.deletes(), 1);
    assert.equal(f.values.has(staged), false);
    preservesUnrelated(f);
  }
});
