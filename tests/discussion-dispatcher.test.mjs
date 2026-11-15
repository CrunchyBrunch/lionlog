import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { generateKeyPairSync, sign, verify } from 'node:crypto';

const source = readFileSync(new URL('../dispatcher/Code.gs', import.meta.url), 'utf8');
const day = '2026-11-10';
const claim = `lionlog-dispatch-claim:${day}`;

function fixture({ minute = '05:17', commentStatus = 200, lockAvailable = true, privateKey,
  computeRsaSha256Signature = () => [1, 2, 3] } = {}) {
  const values = new Map([
    ['LIONLOG_DISPATCH_ACTIVATION', 'ENABLE_LIONLOG_EXTERNAL_DISPATCH'],
    ['LIONLOG_DISCUSSION_NODE_ID', 'D_kwABC123'], ['LIONLOG_APP_ID', '123'],
    ['LIONLOG_INSTALLATION_ID', '456'],
    ['LIONLOG_APP_PRIVATE_KEY_PEM', privateKey ?? '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----']
  ]);
  const posts = [];
  let lockHeld = false;
  let triggerCount = 0;
  const properties = { getProperty: (key) => values.has(key) ? values.get(key) : null,
    setProperty: (key, value) => { values.set(key, value); } };
  const context = {
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : ['2026-11-10T10:17:00Z'])); } },
    Number, JSON, Error,
    Utilities: {
      formatDate: (_date, zone, format) => { assert.equal(zone, 'America/New_York');
        return format === 'yyyy-MM-dd' ? day : minute; },
      base64EncodeWebSafe: (input) => Buffer.from(input).toString('base64url'),
      computeRsaSha256Signature
    },
    LockService: { getScriptLock: () => ({ tryLock: () => { if (!lockAvailable) return false;
      lockHeld = true; return true; }, releaseLock: () => { lockHeld = false; } }) },
    PropertiesService: { getScriptProperties: () => properties },
    ScriptApp: { getProjectTriggers: () => triggerCount ? [{ getHandlerFunction: () => 'dispatchLionLogWake' }] : [],
      newTrigger: handler => { assert.equal(handler, 'dispatchLionLogWake'); return {
        timeBased: () => ({ everyMinutes: count => { assert.equal(count, 5); return {
          create: () => { triggerCount += 1; }
        }; } })
      }; } },
    UrlFetchApp: { fetch: (url, options) => {
      assert.equal(lockHeld, false);
      assert.ok(values.has(claim), 'date claim must precede every network request');
      posts.push({ url, options });
      if (url.includes('/access_tokens')) return { getResponseCode: () => 201,
        getContentText: () => JSON.stringify({ token: 'installation-token' }) };
      return { getResponseCode: () => commentStatus,
        getContentText: () => JSON.stringify({ data: { addDiscussionComment: { comment: {
          id: 'DC_kwABC123', databaseId: 12345, body: `lionlog-dispatch.v1:${day}`,
          discussion: { id: 'D_kwABC123' }
        } } } }) };
    } }
  };
  vm.runInNewContext(source, context);
  return { run: () => vm.runInNewContext('dispatchLionLogWake()', context),
    install: () => vm.runInNewContext('installLionLogDispatcherTrigger()', context),
    triggerCount: () => triggerCount, values, posts };
}

test('installer creates one five-minute trigger and remains idempotent', () => {
  const f = fixture(); f.install(); f.install();
  assert.equal(f.triggerCount(), 1);
});

test('one durable claim precedes exactly one comment POST', () => {
  const f = fixture();
  f.run();
  assert.equal(f.posts.length, 2);
  assert.equal(f.posts[1].url, 'https://api.github.com/graphql');
  assert.equal(JSON.parse(f.posts[0].options.payload).repository_ids[0], 1346360244);
  assert.equal(JSON.parse(f.posts[0].options.payload).permissions.discussions, 'write');
  assert.deepEqual(JSON.parse(f.posts[1].options.payload).variables,
    { discussionId: 'D_kwABC123', body: `lionlog-dispatch.v1:${day}` });
  assert.equal(JSON.parse(f.values.get(claim)).state, 'posted');
  f.run();
  assert.equal(f.posts.length, 2);
});

test('PKCS#8 disposable key signs a verifiable GitHub App JWT', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const f = fixture({ privateKey, computeRsaSha256Signature: (input, key) => {
    assert.match(key, /^-----BEGIN PRIVATE KEY-----/);
    return [...sign('RSA-SHA256', Buffer.from(input), key)];
  } });
  f.run();
  const jwt = f.posts[0].options.headers.Authorization.slice('Bearer '.length);
  const [header, payload, signature] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).iss, '123');
  assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey,
    Buffer.from(signature, 'base64url')), true);
  assert.equal(f.posts.length, 2);
});

test('original PKCS#1 App key is rejected before claiming a date', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const f = fixture({ privateKey });
  assert.throws(f.run, /configuration is incomplete/);
  assert.equal(f.values.has(claim), false);
  assert.equal(f.posts.length, 0);
});

test('uncertain POST consumes the day without retry', () => {
  const f = fixture({ commentStatus: 502 });
  assert.throws(f.run, /uncertain/);
  assert.equal(JSON.parse(f.values.get(claim)).state, 'claimed');
  f.run();
  assert.equal(f.posts.length, 2);
});

test('early, late and unavailable lock never POST', () => {
  for (const minute of ['05:16', '12:15', '15:48']) {
    const f = fixture({ minute }); f.run();
    assert.equal(f.posts.length, 0);
  }
  const locked = fixture({ lockAvailable: false });
  assert.throws(locked.run, /lock unavailable/);
  assert.equal(locked.posts.length, 0);
});
