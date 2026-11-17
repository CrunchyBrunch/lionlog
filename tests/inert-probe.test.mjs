import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const dispatcher = readFileSync(new URL('../dispatcher/Code.gs', import.meta.url), 'utf8');
const probe = readFileSync(new URL('../dispatcher/InertProbe.gs', import.meta.url), 'utf8');
const claim = 'INERT_PROBE_POST_ATTEMPT';
const botId = 356656801;
const day = '2026-11-17';
const body = `lionlog-dispatch.v1:${day}`;

function fixture({ login = 'lionlog-daily-menu-dispatcher', authorId = botId,
  authorType = 'Bot', commentResponse = 200, commentThrows = false,
  graphqlErrors = false, priorAttempt, commentNodeId = 'DC_kwABC123',
  activation = '', privateKey = '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----' } = {}) {
  const values = new Map([
    ['LIONLOG_APP_ID', '5759481'], ['LIONLOG_INSTALLATION_ID', '181943702'],
    ['LIONLOG_DISCUSSION_NODE_ID', 'D_kwDOUD_TtM4ArH9U'],
    ['LIONLOG_APP_PRIVATE_KEY_PEM', privateKey],
  ]);
  if (activation) values.set('LIONLOG_DISPATCH_ACTIVATION', activation);
  if (priorAttempt !== undefined) values.set(claim, priorAttempt);
  const posts = [];
  const logs = [];
  let locked = false;
  const context = {
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : ['2026-11-17T10:17:00Z'])); } },
    Number, JSON, Object, Error,
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => values.get(key) ?? null,
      setProperty: (key, value) => values.set(key, value),
    }) },
    LockService: { getScriptLock: () => ({
      waitLock: () => { locked = true; }, releaseLock: () => { locked = false; },
    }) },
    Utilities: {
      formatDate: (_date, zone, format) => { assert.equal(zone, 'America/New_York');
        assert.equal(format, 'yyyy-MM-dd'); return day; },
      base64EncodeWebSafe: value => Buffer.from(typeof value === 'string' ? value : value).toString('base64url'),
      computeRsaSha256Signature: (_input, key) => {
        assert.match(key, /^-----BEGIN PRIVATE KEY-----/); return [1, 2, 3];
      },
    },
    UrlFetchApp: { fetch: (url, options) => {
      assert.equal(locked, true);
      posts.push({ url, options });
      if (url.includes('/access_tokens')) return { getResponseCode: () => 201,
        getContentText: () => JSON.stringify({ token: 'fixture-token', permissions: { discussions: 'write', metadata: 'read' } }) };
      assert.ok(values.has(claim), 'one-shot claim must precede the comment POST');
      if (commentThrows) throw new Error('lost POST response');
      return { getResponseCode: () => commentResponse,
        getContentText: () => JSON.stringify({ ...(graphqlErrors ? { errors: [{ message: 'partial response' }] } : {}),
          data: { addDiscussionComment: { comment: {
          id: commentNodeId, databaseId: 12345, body,
          discussion: { id: 'D_kwDOUD_TtM4ArH9U' },
          author: { __typename: authorType, databaseId: authorId, login },
        } } } }) };
    } },
    console: { log: value => logs.push(value) },
  };
  vm.runInNewContext(`${dispatcher}\n${probe}`, context);
  return { run: () => vm.runInNewContext('runLionLogInertProbe()', context), values, posts, logs };
}

test('the one-shot probe accepts both observed GraphQL Bot logins', () => {
  for (const login of ['lionlog-daily-menu-dispatcher', 'lionlog-daily-menu-dispatcher[bot]']) {
    const f = fixture({ login });
    f.run();
    assert.equal(f.posts.length, 2);
    const mutation = JSON.parse(f.posts[1].options.payload);
    assert.match(mutation.query, /author\{__typename login \.\.\. on Bot\{databaseId\}\}/);
    assert.equal(mutation.variables.body, body);
    assert.ok(f.values.has(claim));
    assert.throws(f.run, /Probe unavailable/);
    assert.equal(f.posts.length, 2);
  }
});

test('wrong Bot ID, type and login remain unconfirmed and cannot repost', () => {
  for (const variation of [
    { authorId: 5759481 }, { authorId: '356656801' },
    { authorType: 'User' }, { login: 'other-dispatcher[bot]' },
  ]) {
    const f = fixture(variation);
    assert.throws(f.run, /Comment outcome unconfirmed/);
    assert.ok(f.values.has(claim));
    assert.throws(f.run, /Probe unavailable/);
    assert.equal(f.posts.length, 2);
  }
});

test('an ambiguous comment POST consumes the attempt without retry', () => {
  for (const variation of [{ commentThrows: true }, { commentResponse: 502 }, { graphqlErrors: true }]) {
    const f = fixture(variation);
    assert.throws(f.run);
    assert.ok(f.values.has(claim));
    assert.throws(f.run, /Probe unavailable/);
    assert.equal(f.posts.length, 2);
  }
});

test('activation and key-format guards stop before any network or claim', () => {
  for (const variation of [
    { activation: 'ENABLE_LIONLOG_EXTERNAL_DISPATCH' },
    { privateKey: '-----BEGIN RSA PRIVATE KEY-----\nfixture\n-----END RSA PRIVATE KEY-----' },
  ]) {
    const f = fixture(variation);
    assert.throws(f.run);
    assert.equal(f.posts.length, 0);
    assert.equal(f.values.has(claim), false);
  }
});

test('an existing blank attempt marker blocks before token exchange', () => {
  const f = fixture({ priorAttempt: '' });
  assert.throws(f.run, /Probe unavailable/);
  assert.equal(f.posts.length, 0);
  assert.equal(f.values.get(claim), '');
});

test('a non-string node ID cannot produce a success receipt or another POST', () => {
  const f = fixture({ commentNodeId: ['DC_kwABC123'] });
  assert.throws(f.run, /Comment outcome unconfirmed/);
  assert.equal(f.logs.length, 0);
  assert.ok(f.values.has(claim));
  assert.throws(f.run, /Probe unavailable/);
  assert.equal(f.posts.length, 2);
});
