import assert from 'node:assert/strict';
import { createPrivateKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../dispatcher/ProvisionPem.gs', import.meta.url), 'utf8');
const target = 'LIONLOG_APP_PRIVATE_KEY_PEM';
const staged = 'LIONLOG_APP_PRIVATE_KEY_PEM_STAGED_JSON';
const marker = 'INERT_PROBE_POST_ATTEMPT';
const claim = 'lionlog-dispatch-claim:2026-11-14';
const sensitiveCause = 'SENSITIVE_CAUSE_MUST_NOT_ESCAPE';

function fixture({ stagedValue, activation = '', signFails = false, signReturnsEmpty = false, writeFault = null,
  readbackFault = null, lockAvailable = true, currentTarget } = {}) {
  const { privateKey: pem, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const oldKey = createPrivateKey(pem).export({ type: 'pkcs1', format: 'pem' }).replace(/\r?\n/g, ' ').trim();
  const values = new Map([
    [target, currentTarget ?? oldKey], [staged, stagedValue ?? JSON.stringify(pem)],
    [marker, '2026-11-14T15:27:59.677Z'], [claim, 'retained claim'],
    ['LIONLOG_DISPATCH_ACTIVATION', activation], ['UNRELATED', 'preserve me'],
  ]);
  const originalStaged = values.get(staged);
  let writes = 0;
  let signCalls = 0;
  let locked = false;
  const context = {
    Error, JSON, Number, String, Array,
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => {
        if (key === target && writes > 0 && readbackFault) {
          if (readbackFault === 'throw') throw Error(sensitiveCause);
          return 'mismatched readback';
        }
        return values.get(key) ?? null;
      },
      setProperty: (key, value) => {
        assert.equal(key, target, 'only the intended key property may be written');
        assert.equal(locked, true);
        writes += 1;
        if (writeFault === 'before') throw Error(sensitiveCause);
        values.set(key, value);
        if (writeFault === 'after') throw Error(sensitiveCause);
      },
      deleteProperty: () => { throw Error('unexpected property deletion'); },
    }) },
    LockService: { getScriptLock: () => ({
      tryLock: () => { if (!lockAvailable) return false; locked = true; return true; },
      releaseLock: () => { assert.equal(locked, true); locked = false; },
    }) },
    Utilities: { computeRsaSha256Signature: (message, key) => {
      signCalls += 1;
      if (signFails) throw Error(sensitiveCause);
      if (signReturnsEmpty) return [];
      const signature = sign('RSA-SHA256', Buffer.from(message), key);
      assert.ok(verify('RSA-SHA256', Buffer.from(message), publicKey, signature));
      return [...signature];
    } },
    UrlFetchApp: { fetch: () => { throw Error('network call prohibited'); } },
    ScriptApp: { newTrigger: () => { throw Error('trigger change prohibited'); } },
    console: { log: () => { throw Error('logging prohibited'); } },
  };
  vm.runInNewContext(source, context);
  return { run: () => vm.runInNewContext('provisionLionLogDispatcherPem()', context),
    values, pem, oldKey, originalStaged, writes: () => writes, signCalls: () => signCalls,
    locked: () => locked };
}

function assertUnrelatedPreserved(f) {
  assert.equal(f.values.get(marker), '2026-11-14T15:27:59.677Z');
  assert.equal(f.values.get(claim), 'retained claim');
  assert.equal(f.values.get('LIONLOG_DISPATCH_ACTIVATION'), '');
  assert.equal(f.values.get('UNRELATED'), 'preserve me');
  assert.ok(f.values.get(staged) === f.originalStaged, 'staged property remains unchanged for manual cleanup');
  assert.equal(f.locked(), false);
}

function assertRedactedFailure(f, pattern) {
  assert.throws(f.run, error => pattern.test(error.message)
    && !error.message.includes(sensitiveCause) && !error.message.includes('PRIVATE KEY'));
  assert.equal(f.locked(), false);
}

test('valid JSON-escaped PKCS#8 is signed locally, written once and read back exactly', () => {
  const f = fixture();
  assert.equal(f.originalStaged.includes('\n'), false, 'the staged JSON is one line');
  assert.ok(f.originalStaged.length < 9 * 1024, 'the staged value fits the documented property limit');
  assert.equal(f.run(), true);
  assert.equal(f.signCalls(), 1);
  assert.equal(f.writes(), 1);
  assert.ok(f.values.get(target) === f.pem, 'the stored PEM must match the decoded input exactly');
  assertUnrelatedPreserved(f);
  assertRedactedFailure(f, /before key write/);
  assert.equal(f.writes(), 1, 'a second invocation cannot overwrite the provisioned key');
});

test('invalid JSON, value types and PEM formats stop before signing or writing', () => {
  for (const stagedValue of [
    '{', 'null', '42', '{}', JSON.stringify('not a key'),
    JSON.stringify('-----BEGIN PRIVATE KEY----- MII -----END PRIVATE KEY-----'),
    JSON.stringify('-----BEGIN ENCRYPTED PRIVATE KEY-----\nAA==\n-----END ENCRYPTED PRIVATE KEY-----'),
    JSON.stringify('-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----\nextra'),
  ]) {
    const f = fixture({ stagedValue });
    assertRedactedFailure(f, /before key write/);
    assert.equal(f.signCalls(), 0);
    assert.equal(f.writes(), 0);
    assert.ok(f.values.get(target) === f.oldKey);
    assertUnrelatedPreserved(f);
  }
});

test('a signer failure is redacted and leaves the intended property unchanged', () => {
  for (const options of [{ signFails: true }, { signReturnsEmpty: true }]) {
    const f = fixture(options);
    assertRedactedFailure(f, /before key write/);
    assert.equal(f.signCalls(), 1);
    assert.equal(f.writes(), 0);
    assert.ok(f.values.get(target) === f.oldKey);
    assertUnrelatedPreserved(f);
  }
});

test('a write that throws after mutation has an uncertain outcome and is never retried', () => {
  const f = fixture({ writeFault: 'after' });
  assertRedactedFailure(f, /outcome uncertain/);
  assert.equal(f.writes(), 1);
  assert.ok(f.values.get(target) === f.pem);
  assertRedactedFailure(f, /before key write/);
  assert.equal(f.writes(), 1);
  assertUnrelatedPreserved(f);
});

test('a write that throws before mutation is still reported as uncertain', () => {
  const f = fixture({ writeFault: 'before' });
  assertRedactedFailure(f, /outcome uncertain/);
  assert.equal(f.writes(), 1);
  assert.ok(f.values.get(target) === f.oldKey);
  assertUnrelatedPreserved(f);
});

test('readback mismatch or exception stays uncertain after one write', () => {
  for (const readbackFault of ['mismatch', 'throw']) {
    const f = fixture({ readbackFault });
    assertRedactedFailure(f, /outcome uncertain/);
    assert.equal(f.writes(), 1);
    assert.ok(f.values.get(target) === f.pem);
    assertUnrelatedPreserved(f);
  }
});

test('active dispatch, unexpected target and missing lock prevent every write', () => {
  for (const options of [
    { activation: 'ENABLE_LIONLOG_EXTERNAL_DISPATCH' },
    { currentTarget: 'unexpected target value' },
    { currentTarget: '-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----' },
    { lockAvailable: false },
  ]) {
    const f = fixture(options);
    assertRedactedFailure(f, /before key write/);
    assert.equal(f.signCalls(), 0);
    assert.equal(f.writes(), 0);
  }
});
