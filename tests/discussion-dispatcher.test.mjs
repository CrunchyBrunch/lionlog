import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../dispatcher/Code.gs', import.meta.url), 'utf8');
const day = '2026-11-10';
const claim = `lionlog-dispatch-claim:${day}`;

function fixture({ minute = '05:17', commentStatus = 200, lockAvailable = true } = {}) {
  const values = new Map([
    ['LIONLOG_DISPATCH_ACTIVATION', 'ENABLE_LIONLOG_EXTERNAL_DISPATCH'],
    ['LIONLOG_DISCUSSION_NODE_ID', 'D_kwABC123'], ['LIONLOG_APP_ID', '123'],
    ['LIONLOG_INSTALLATION_ID', '456'],
    ['LIONLOG_APP_PRIVATE_KEY_PEM', '-----BEGIN RSA PRIVATE KEY-----\nfixture']
  ]);
  const posts = [];
  let lockHeld = false;
  const properties = { getProperty: (key) => values.has(key) ? values.get(key) : null,
    setProperty: (key, value) => { values.set(key, value); } };
  const context = {
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : ['2026-11-10T10:17:00Z'])); } },
    Number, JSON, Error,
    Utilities: {
      formatDate: (_date, zone, format) => { assert.equal(zone, 'America/New_York');
        return format === 'yyyy-MM-dd' ? day : minute; },
      base64EncodeWebSafe: () => 'abc', computeRsaSha256Signature: () => [1, 2, 3]
    },
    LockService: { getScriptLock: () => ({ tryLock: () => { if (!lockAvailable) return false;
      lockHeld = true; return true; }, releaseLock: () => { lockHeld = false; } }) },
    PropertiesService: { getScriptProperties: () => properties },
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
  return { run: () => vm.runInNewContext('dispatchLionLogWake()', context), values, posts };
}

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
