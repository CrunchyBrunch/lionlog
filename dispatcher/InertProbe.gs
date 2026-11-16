/* Offline staging copy of the one-shot harmless probe. Deploy only after independent review. */
function runLionLogInertProbe() {
  const properties = PropertiesService.getScriptProperties();
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (properties.getProperty('LIONLOG_DISPATCH_ACTIVATION')
      || properties.getProperty('INERT_PROBE_POST_ATTEMPT')) throw Error('Probe unavailable.');
    const appId = properties.getProperty('LIONLOG_APP_ID');
    const installationId = properties.getProperty('LIONLOG_INSTALLATION_ID');
    const discussionId = properties.getProperty('LIONLOG_DISCUSSION_NODE_ID');
    if (appId !== '5759481' || installationId !== '181943702'
      || discussionId !== 'D_kwDOUD_TtM4ArH9U') throw Error('Probe identity mismatch.');
    const privateKey = properties.getProperty('LIONLOG_APP_PRIVATE_KEY_PEM') || '';
    if (!/^-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----\s*$/.test(privateKey)) {
      throw Error('PKCS#8 PEM property missing or malformed.');
    }
    // Reuse the reviewed PR35 signer from Code.gs in the same Apps Script project.
    const jwt = lionlogAppJwt(appId, privateKey, new Date());
    const response = UrlFetchApp.fetch('https://api.github.com/app/installations/' + installationId + '/access_tokens', {
      method: 'post', headers: { Authorization: 'Bearer ' + jwt }, contentType: 'application/json',
      payload: JSON.stringify({ repository_ids: [1346360244], permissions: { discussions: 'write' } }),
      muteHttpExceptions: true, followRedirects: false,
    });
    if (response.getResponseCode() !== 201) throw Error('Token request failed HTTP ' + response.getResponseCode());
    const data = JSON.parse(response.getContentText());
    if (!data.token || data.permissions?.discussions !== 'write'
      || Object.keys(data.permissions).some((key) => key !== 'discussions'
        && !(key === 'metadata' && data.permissions[key] === 'read'))) throw Error('Token scope mismatch.');
    const body = 'lionlog-dispatch.v1:' + Utilities.formatDate(new Date(), 'America/New_York', 'yyyy-MM-dd');
    // A lost response or invalid readback still consumes this one allowed POST attempt.
    properties.setProperty('INERT_PROBE_POST_ATTEMPT', new Date().toISOString());
    const result = UrlFetchApp.fetch('https://api.github.com/graphql', {
      method: 'post', headers: { Authorization: 'Bearer ' + data.token }, contentType: 'application/json',
      muteHttpExceptions: true, followRedirects: false,
      payload: JSON.stringify({ query: 'mutation($id:ID!,$body:String!){addDiscussionComment(input:{discussionId:$id,body:$body}){comment{id databaseId body discussion{id} author{__typename login ... on Bot{databaseId}}}}}',
        variables: { id: discussionId, body } }),
    });
    if (result.getResponseCode() !== 200) throw Error('Comment outcome unconfirmed. Inspect GitHub.');
    let payload;
    try { payload = JSON.parse(result.getContentText()); }
    catch { throw Error('Comment outcome unconfirmed. Inspect GitHub.'); }
    const comment = payload?.data?.addDiscussionComment?.comment;
    const author = comment?.author;
    if (payload?.errors !== undefined || !/^DC_[A-Za-z0-9_-]+$/.test(comment?.id || '')
      || !Number.isSafeInteger(comment?.databaseId) || comment.databaseId < 1
      || comment.discussion?.id !== discussionId || comment.body !== body
      || author?.__typename !== 'Bot' || author.databaseId !== 356656801
      || !['lionlog-daily-menu-dispatcher', 'lionlog-daily-menu-dispatcher[bot]'].includes(author.login)) {
      throw Error('Comment outcome unconfirmed. Inspect GitHub.');
    }
    console.log('Probe comment ' + comment.databaseId + ' ' + comment.id);
  } finally {
    lock.releaseLock();
  }
}
