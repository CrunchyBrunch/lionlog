import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../dispatcher/ClearReconciledProbeMarker.gs', import.meta.url), 'utf8');
const marker = 'INERT_PROBE_POST_ATTEMPT';
const reconciled = '2026-11-14T15:27:59.677Z';
const key = 'LIONLOG_APP_PRIVATE_KEY_PEM';
const activation = 'LIONLOG_DISPATCH_ACTIVATION';
const dayClaim = 'lionlog-dispatch-claim:2026-11-14';
const { privateKey: pem } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const stopped = { message: 'Marker cleanup stopped before deletion.' };
const uncertain = { message: 'Marker cleanup outcome uncertain. Reconcile read-only before proceeding.' };

function fixture({ markerValue = reconciled, keyValue = pem, gate, lockAvailable = true,
  fault } = {}) {
  const properties = new Map([[marker, markerValue], [key, keyValue], [dayClaim, 'retained claim'],
    ['UNRELATED', 'retained value'], [activation, gate]]);
  const deletions = [];
  let locked = false;
  const checkLocked = () => assert.equal(locked, true);
  const context = {
    LockService: { getScriptLock: () => ({
      tryLock: () => { locked = lockAvailable; return locked; },
      releaseLock: () => { checkLocked(); locked = false; },
    }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty(name) {
        checkLocked();
        if (name === key && fault === (deletions.length ? 'after-read' : 'before-read')) {
          throw Error('secret diagnostic');
        }
        return properties.get(name) ?? null;
      },
      deleteProperty(name) {
        checkLocked();
        deletions.push(name);
        if (fault === 'delete-throws-before') throw Error('secret diagnostic');
        if (fault !== 'delete-noop') properties.delete(name);
        if (fault === 'delete-throws-after') throw Error('secret diagnostic');
        if (fault === 'key-changed') properties.set(key, pem.replace(/\r?\n/g, ''));
      },
    }) },
  };
  vm.runInNewContext(source, context);
  return {
    properties, deletions,
    run() {
      try { return vm.runInNewContext('clearLionLogReconciledProbeMarker()', context); }
      finally { assert.equal(locked, false); }
    },
  };
}

test('clears only the reconciled marker, preserves exact multiline bytes and blocks a repeat', () => {
  const keyValue = pem.replace(/\n/g, '\r\n');
  const f = fixture({ keyValue });
  const expected = new Map(f.properties);
  expected.delete(marker);
  assert.equal(f.run(), true);
  assert.deepEqual(f.deletions, [marker]);
  assert.ok(f.properties.get(key) === keyValue);
  assert.deepEqual(f.properties, expected);
  assert.throws(f.run, stopped);
  assert.deepEqual(f.deletions, [marker]);
});

test('missing, blank and different markers, active dispatch, bad key or unavailable lock block deletion', () => {
  for (const options of [
    { markerValue: null }, { markerValue: '' }, { markerValue: reconciled + ' ' },
    { markerValue: '2026-11-19T15:27:59.677Z' }, { gate: 'ENABLE_LIONLOG_EXTERNAL_DISPATCH' },
    { keyValue: null }, { keyValue: '' }, { keyValue: pem.replace(/\r?\n/g, '') },
    { keyValue: pem.replaceAll('PRIVATE KEY', 'RSA PRIVATE KEY') },
    { lockAvailable: false }, { fault: 'before-read' },
  ]) {
    const f = fixture(options);
    const expected = new Map(f.properties);
    assert.throws(f.run, stopped);
    assert.deepEqual(f.deletions, []);
    assert.deepEqual(f.properties, expected);
  }
});

test('deletion exceptions and failed readback report fixed uncertainty with one attempt', () => {
  for (const fault of ['delete-throws-before', 'delete-throws-after', 'delete-noop', 'key-changed', 'after-read']) {
    const f = fixture({ fault });
    assert.throws(f.run, uncertain);
    assert.deepEqual(f.deletions, [marker]);
    assert.equal(f.properties.get(dayClaim), 'retained claim');
    assert.equal(f.properties.get('UNRELATED'), 'retained value');
  }
});
