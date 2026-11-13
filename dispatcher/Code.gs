/* Offline source only. Install and schedule this standalone Apps Script during cutover. */
const LIONLOG_ZONE = 'America/New_York';
const LIONLOG_REPOSITORY_ID = 1346360244;
const LIONLOG_GATE = 'ENABLE_LIONLOG_EXTERNAL_DISPATCH';

/** Run once during owner cutover. A five-minute trigger and local gate absorb timer jitter. */
function installLionLogDispatcherTrigger() {
  const matches = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === 'dispatchLionLogWake';
  });
  if (matches.length > 1) throw new Error('Duplicate dispatcher triggers require owner inspection.');
  if (matches.length === 1) return;
  ScriptApp.newTrigger('dispatchLionLogWake').timeBased().everyMinutes(5).create();
}

/** Each five-minute tick checks the New York due window. A claimed day is never retried. */
function dispatchLionLogWake() {
  const now = new Date();
  const day = Utilities.formatDate(now, LIONLOG_ZONE, 'yyyy-MM-dd');
  const minuteText = Utilities.formatDate(now, LIONLOG_ZONE, 'HH:mm');
  const minute = Number(minuteText.slice(0, 2)) * 60 + Number(minuteText.slice(3));
  if (minute < 5 * 60 + 17 || minute >= 12 * 60 + 15) return;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('Dispatch lock unavailable; no retry.');
  let settings;
  try {
    const properties = PropertiesService.getScriptProperties();
    if (properties.getProperty('LIONLOG_DISPATCH_ACTIVATION') !== LIONLOG_GATE) return;
    const discussionId = properties.getProperty('LIONLOG_DISCUSSION_NODE_ID');
    const appId = properties.getProperty('LIONLOG_APP_ID');
    const installationId = properties.getProperty('LIONLOG_INSTALLATION_ID');
    const privateKey = properties.getProperty('LIONLOG_APP_PRIVATE_KEY_PEM');
    if (!/^D_[A-Za-z0-9_-]+$/.test(discussionId || '') || !/^[1-9]\d*$/.test(appId || '')
      || !/^[1-9]\d*$/.test(installationId || '') || !/^-----BEGIN RSA PRIVATE KEY-----/.test(privateKey || '')) {
      throw new Error('Dispatcher configuration is incomplete.');
    }
    const claimKey = 'lionlog-dispatch-claim:' + day;
    if (properties.getProperty(claimKey) !== null) return;
    // Persist before any network request. Failure, timeout and ambiguous POST all consume this date.
    properties.setProperty(claimKey, JSON.stringify({ state: 'claimed', day: day,
      claimedAt: now.toISOString(), discussionId: discussionId }));
    settings = { discussionId: discussionId, appId: appId, installationId: installationId,
      privateKey: privateKey, claimKey: claimKey };
  } finally {
    lock.releaseLock();
  }

  const jwt = lionlogAppJwt(settings.appId, settings.privateKey, now);
  const installationResponse = UrlFetchApp.fetch(
    'https://api.github.com/app/installations/' + settings.installationId + '/access_tokens',
    { method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ repository_ids: [LIONLOG_REPOSITORY_ID],
        permissions: { discussions: 'write' } }), muteHttpExceptions: true,
      followRedirects: false,
      headers: { Authorization: 'Bearer ' + jwt, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10' } });
  if (installationResponse.getResponseCode() !== 201) throw new Error('Installation token request failed; date remains claimed.');
  const tokenResponse = JSON.parse(installationResponse.getContentText());
  if (typeof tokenResponse.token !== 'string' || !tokenResponse.token) throw new Error('Installation token missing.');

  const body = 'lionlog-dispatch.v1:' + day;
  const commentResponse = UrlFetchApp.fetch('https://api.github.com/graphql', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    followRedirects: false,
    headers: { Authorization: 'Bearer ' + tokenResponse.token,
      Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' },
    payload: JSON.stringify({ query: 'mutation($discussionId:ID!,$body:String!){addDiscussionComment(input:{discussionId:$discussionId,body:$body}){comment{id databaseId body discussion{id}}}}',
      variables: { discussionId: settings.discussionId, body: body } })
  });
  if (commentResponse.getResponseCode() !== 200) throw new Error('Comment POST outcome is uncertain; date remains claimed.');
  const result = JSON.parse(commentResponse.getContentText());
  const comment = result.data && result.data.addDiscussionComment && result.data.addDiscussionComment.comment;
  if (result.errors || !comment || !/^DC_[A-Za-z0-9_-]+$/.test(comment.id)
    || !Number.isSafeInteger(comment.databaseId) || comment.databaseId < 1
    || comment.body !== body || comment.discussion.id !== settings.discussionId) {
    throw new Error('Comment POST readback is invalid; date remains claimed.');
  }
  // An operational receipt only; the claim was already durable before POST.
  PropertiesService.getScriptProperties().setProperty(settings.claimKey,
    JSON.stringify({ state: 'posted', day: day, commentId: comment.databaseId,
      commentNodeId: comment.id, discussionId: settings.discussionId }));
}

function lionlogAppJwt(appId, privateKey, now) {
  const epoch = Math.floor(now.getTime() / 1000);
  const encode = function (value) {
    return Utilities.base64EncodeWebSafe(JSON.stringify(value)).replace(/=+$/, '');
  };
  const input = encode({ alg: 'RS256', typ: 'JWT' }) + '.'
    + encode({ iat: epoch - 60, exp: epoch + 540, iss: appId });
  const signature = Utilities.computeRsaSha256Signature(input, privateKey);
  return input + '.' + Utilities.base64EncodeWebSafe(signature).replace(/=+$/, '');
}
