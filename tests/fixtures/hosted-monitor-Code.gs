// LionLog publication monitor. Existing five-minute trigger calls dryRunPoll.
const apiRoot = 'https://api.github.com/repos/CrunchyBrunch/lionlog/';
const publicMarker = 'https://crunchybrunch.github.io/lionlog/release.json';
const prodBranch = 'production/daily-menus';
const zone = 'America/New_York';
function dayOf(t) { return Utilities.formatDate(new Date(t),zone,'yyyy-MM-dd'); }
function minuteOf(t) { return Utilities.formatDate(new Date(t),zone,'HH:mm'); }
function requireEvidence(ok, reason) { if (!ok) throw Error(reason); }
function readGithub(path, token) {
  const response=UrlFetchApp.fetch(apiRoot+path,{method:'get',followRedirects:false,muteHttpExceptions:true,headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json'}});
  requireEvidence(response.getResponseCode()===200,'GitHub read '+response.getResponseCode());
  return JSON.parse(response.getContentText());
}
function runs(file, branch, event, day, token) {
  const out=readGithub('actions/workflows/'+file+'/runs?per_page=100&event='+event+'&branch='+encodeURIComponent(branch)+'&created='+encodeURIComponent('>='+day+'T00:00:00Z'),token);
  requireEvidence(out.total_count===out.workflow_runs.length,'Incomplete run listing');
  const found=out.workflow_runs.filter(r=>dayOf(r.created_at)===day);
  requireEvidence(found.every(r=>r.run_attempt===1 && r.path==='.github/workflows/'+file && r.head_branch===branch && r.event===event),'Unexpected run identity');
  return found;
}
function steps(run,token) {
  const result=readGithub('actions/runs/'+run.id+'/attempts/1/jobs?per_page=100',token);
  requireEvidence(result.jobs.length===result.total_count,'Incomplete jobs');
  return result.jobs.flatMap(j=>j.steps||[]);
}
function hashed(bytes) {return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,bytes).map(x=>('0'+(x&255).toString(16)).slice(-2)).join('');}
function releaseProof(token) {
  const state=readGithub('git/ref/heads/lionlog-publication-state',token).object.sha;
  const commit=readGithub('commits/'+state,token);
  function file(name){const obj=readGithub('contents/'+name+'.json?ref='+state,token);const bytes=Utilities.base64Decode(obj.content);return {data:JSON.parse(Utilities.newBlob(bytes).getDataAsString()),digest:hashed(bytes)};}
  const cp=file('checkpoint').data, receipt=file('receipt'), manifest=file('manifest');
  const m=manifest.data,r=receipt.data;
  const response=UrlFetchApp.fetch(publicMarker,{followRedirects:false,muteHttpExceptions:true});
  requireEvidence(response.getResponseCode()===200,'Public marker read '+response.getResponseCode());
  const marker=JSON.parse(response.getContentText());
  const signed=commit.sha===state && commit.commit.verification.verified && commit.author?.id===349336648 && cp.writerId===349336648 && commit.parents.length===1 && cp.stateParentSha===commit.parents[0].sha;
  const bound=signed && cp.publication.receiptSha256===receipt.digest && cp.publication.manifestSha256===manifest.digest && cp.publication.releaseId===m.releaseId && r.release.id===m.releaseId && r.workflow.runId===cp.boundary.runId && r.workflow.runAttempt===cp.boundary.runAttempt && r.candidate.sourceSha===m.source.commitSha && cp.publication.sourceSha===m.source.commitSha && r.knownGood===true && r.unresolved===false && r.public.inventoryVerified && r.public.browserVerified && r.public.markerVerified;
  return {state,marker:marker.releaseId,release:m.releaseId,date:m.menu.serviceDate,fresh:Date.parse(m.menu.earliestFreshUntil),bound,match:marker.releaseId===m.releaseId && hashed(response.getContent())===m.marker.sha256,coverage:m.menu.coverage,omitted:m.menu.omissions['invalid-name'],candidate:m.source.workflowRunId,promotion:r.workflow.runId};
}
function evidence(now,day,token) {
  const root=runs('daily-publication.yml','main','schedule',day,token);
  requireEvidence(root.length<=1,'Ambiguous daily run');
  const run=root[0], proof=releaseProof(token);
  let started=null, admitted=false, fail=false, terminal=false, promotion=null, candidate=null, writer=null;
  if(run){
    const executed=steps(run,token).find(s=>s.started_at && s.conclusion!=='skipped' && s.status!=='queued' && s.status!=='pending');
    started=executed?Date.parse(executed.started_at):null;
    fail=run.status==='completed' && run.conclusion!=='success';terminal=run.status==='completed';
    const files=['build-live-menu-artifact.yml','deploy-github-pages.yml','advance-refresh-checkpoint.yml'];
    const stages=files.map(f=>runs(f,prodBranch,'workflow_dispatch',day,token).filter(r=>r.created_at>=run.created_at));
    requireEvidence(stages.every(a=>a.length<=1),'Ambiguous downstream runs');
    [candidate,promotion,writer]=stages.map(a=>a[0]);
    if(candidate){const admission=steps(candidate,token).find(s=>s.name==='Verify automatic due date, publication state, complete run accounting, and remaining budget');admitted=admission?.conclusion==='success' && minuteOf(admission.started_at)<'12:15';}
    fail=fail||[candidate,promotion,writer].some(r=>r?.status==='completed' && r.conclusion!=='success');
  }
  const today=proof.date===day;
  const linked=!!(candidate && promotion && writer && proof.candidate===candidate.id && proof.promotion===promotion.id && writer.conclusion==='success' && run.conclusion==='success');
  const expired=today && now>=proof.fresh;
  const success=today && proof.bound && proof.match && linked && proof.coverage==='complete' && proof.omitted===0 && !expired;
  const moving=promotion && !!started && now<started+10800000 && !terminal && !fail;
  const integrity=!proof.bound || (!proof.match && !moving) || (run?.conclusion==='success' && (!today || !linked || !proof.match || proof.coverage!=='complete' || proof.omitted!==0));
  const minute=minuteOf(now);
  return {alerts:{'morning-start':minute>='10:00' && !started && !success,'final-admission':minute>='12:20' && !admitted && !success,'workflow-failure':fail,'publication-integrity':integrity,'completion-freshness':!!(expired || (started && !success && (terminal || now>=started+10800000)))},detail:{day,run:run?.id||null,conclusion:run?.conclusion||null,candidate:candidate?.id||null,promotion:promotion?.id||null,writer:writer?.id||null,proof}};
}
function dryRunPoll(){
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try {
    const now=Date.now(), day=dayOf(now), props=PropertiesService.getScriptProperties();
    const key='production-incidents-'+day, prev=JSON.parse(props.getProperty(key)||'{}');
    let result;
    try {requireEvidence(Date.parse(props.getProperty('TOKEN_EXPIRES_UTC'))>now,'Monitor credential expired');result=evidence(now,day,props.getProperty('MONITOR_TOKEN'));result.alerts['evidence-unavailable']=false;}
    catch(err){result={alerts:{'evidence-unavailable':true},detail:{day,reason:/^(GitHub read [0-9]{3}|Public marker read [0-9]{3}|Incomplete run listing|Incomplete jobs|Unexpected run identity|Monitor credential expired|Ambiguous daily run|Ambiguous downstream runs)$/.test(err.message)?err.message:"Invalid or unavailable monitor evidence"}};}
    const changes=Object.keys(result.alerts).filter(k=>Boolean(prev[k])!==Boolean(result.alerts[k]));
    if(changes.length){
      const pending='production-mail-pending';requireEvidence(!props.getProperty(pending),'Prior email outcome requires investigation');
      const lines=changes.map(k=>(result.alerts[k]?'ALERT ':'RECOVERY ')+k);
      props.setProperty(pending,JSON.stringify({day,lines,time:now}));
      MailApp.sendEmail('monitor-recipient@example.invalid','LionLog '+day+' — '+lines.join(', '),lines.join('\n')+'\n'+JSON.stringify(result.detail,null,2)+'\nhttps://github.com/CrunchyBrunch/lionlog/actions/workflows/daily-publication.yml');
      props.setProperties({[key]:JSON.stringify(Object.assign(prev,result.alerts))});props.deleteProperty(pending);
    }
    props.setProperty('production-last-poll',JSON.stringify({at:new Date(now),...result}));
    const staleKey='production-incidents-'+dayOf(now-35*86400000);props.deleteProperty(staleKey);
    console.log(JSON.stringify({at:new Date(now),...result}));
  }finally{lock.releaseLock();}
}
