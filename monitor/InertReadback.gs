/* Manual read-only diagnostics for already completed inert attempts. */
function verifyLionLogInertReceiverReadback() {
  return verifyLionLogInertAttempt_({
    day: '2026-11-14', commentId: 19614736, commentNodeId: 'DC_kwDOUD_TtM4BK0wQ',
    runId: 43610324125, sha: '677eff7abf51dfe22614c911df390fdd66c4693c',
  });
}

function verifyLionLogNovember21InertReadback() {
  return verifyLionLogInertAttempt_({
    day: '2026-11-21', commentId: 19794925, commentNodeId: 'DC_kwDOUD_TtM4BLgvt',
    runId: 44906581005, sha: '2027557e6d81ceb4f123f9f6c1194ae5392ea32c',
  });
}

function verifyLionLogInertAttempt_(expected) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('MONITOR_TOKEN');
  if (typeof token !== 'string' || !token.trim()
    || !(Date.parse(props.getProperty('TOKEN_EXPIRES_UTC')) > Date.now())) {
    throw Error('Monitor credential missing or expired');
  }
  const route = 'https://api.github.com/repos/CrunchyBrunch/lionlog/actions/runs/' + expected.runId + '/attempts/1';
  const run = llMonitorGetJson(route, token);
  const title = 'LionLog wake ' + expected.commentId + ' ' + expected.commentNodeId
    + ' D_kwDOUD_TtM4ArH9U lionlog-dispatch.v1:' + expected.day;
  if (run.id !== expected.runId || run.run_attempt !== 1 || run.head_sha !== expected.sha
    || run.event !== 'discussion_comment' || run.head_branch !== 'main'
    || run.path !== '.github/workflows/daily-publication.yml'
    || run.repository?.id !== 1346360244 || run.repository.full_name !== 'CrunchyBrunch/lionlog'
    || run.actor?.id !== 356656801 || run.actor.login !== 'lionlog-daily-menu-dispatcher[bot]'
    || run.display_title !== title || run.status !== 'completed' || run.conclusion !== 'success'
    || !Number.isFinite(Date.parse(run.created_at))
    || Utilities.formatDate(new Date(run.created_at), 'America/New_York', 'yyyy-MM-dd') !== expected.day) {
    throw Error('Probe identity or jobs mismatch');
  }
  const jobs = llMonitorGetJson(route + '/jobs?per_page=100', token);
  if (jobs.total_count !== 2 || !Array.isArray(jobs.jobs) || jobs.jobs.length !== 2
    || !jobs.jobs.every(job => job.run_id === expected.runId && job.status === 'completed')
    || !jobs.jobs.some(job => job.name === 'probe' && job.conclusion === 'success')
    || !jobs.jobs.some(job => job.name === 'publish' && job.conclusion === 'skipped')) {
    throw Error('Probe identity or jobs mismatch');
  }
  const result = { mode: 'probe-only', serviceDate: expected.day, runId: expected.runId, attempt: 1,
    commentId: expected.commentId, commentNodeId: expected.commentNodeId, receiverSha: expected.sha,
    probe: 'success', publish: 'skipped' };
  console.log(JSON.stringify(result));
  return result;
}
