/* Local CircleUp persistence foundation. Bearer workspaces are not production auth. */
(function (global) {
  'use strict';
  const VERSION = 1, MAX_BYTES = 1024 * 1024, DEBOUNCE_MS = 180;
  const KEY_NAME = 'circleup-workspace-key-v1', META_NAME = 'circleup-workspace-sync-v1';
  const KEYS = ['user','name','memberProfile','rsvps','joined','follows','saved','extraEvents','extraTopics','extraReplies','draft','practitionerFollows'];
  const FORBIDDEN = new Set(['__proto__','prototype','constructor']);
  const EVENT_LIMITS = {id:120,name:120,description:1200,community:120,date:10,time:5,timezone:80,format:32,platform:40,place:200,externalLink:2048,visibility:40,roomAccess:80,intent:20,topic:100};
  const defaults = () => ({user:false,name:'You',memberProfile:{},rsvps:[],joined:[],follows:[],saved:[],extraEvents:[],extraTopics:[],extraReplies:{},draft:null,practitionerFollows:[]});
  const clone = value => JSON.parse(JSON.stringify(value));
  const fail = message => { throw new Error(message); };
  function object(value, allowed, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) fail(label+' contains unsupported fields or is not an object.');
  }
  function text(value, max, label) {
    if (typeof value !== 'string' || [...value].length > max || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) fail(label+' is invalid or too long.');
  }
  function array(value, max, label) { if (!Array.isArray(value) || value.length > max) fail(label+' must be a bounded array.'); }
  function stringArray(value, max, length, label) { array(value,max,label); value.forEach(v => text(v,length,label)); }
  function safeTree(value, depth = 0) {
    if (depth > 12) fail('Backup nesting is too deep.');
    if (value && typeof value === 'object') {
      if (!Array.isArray(value) && Object.keys(value).some(k => FORBIDDEN.has(k))) fail('Prototype keys are not supported.');
      Object.values(value).forEach(v => safeTree(v,depth+1));
    } else if (typeof value === 'number' && !Number.isFinite(value)) fail('Non-finite numbers are not supported.');
  }
  function reply(value) {
    object(value,['author','body'],'Reply');
    text(value.author,40,'Reply author'); text(value.body,1000,'Reply body');
  }
  function event(value, draft) {
    object(value,[...Object.keys(EVENT_LIMITS),'capacity'],'Event');
    if (!draft && ['id','name','description','community','date','time','format'].some(k => !(k in value))) fail('Event fields are missing.');
    Object.keys(value).forEach(k => { if(k !== 'capacity') text(value[k],EVENT_LIMITS[k],'Event '+k); });
    if ('capacity' in value && !(draft && value.capacity === null) && (!Number.isInteger(value.capacity) || value.capacity < 2 || value.capacity > 100)) fail('Capacity must be from 2 to 100.');
    if (value.date) {
      const parsed = new Date(value.date+'T00:00:00Z');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value.date) || value.date.startsWith('0000') || !Number.isFinite(+parsed) || parsed.toISOString().slice(0,10) !== value.date) fail('Event date must be valid YYYY-MM-DD.');
    }
    if (value.time && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time)) fail('Event time must be valid HH:MM.');
    if ('format' in value && !['Online','In person','Hybrid',...(draft?['']:[])].includes(value.format)) fail('Unsupported event format.');
  }
  function validate(data) {
    safeTree(data); object(data,KEYS,'Workspace data');
    if ('user' in data && typeof data.user !== 'boolean') fail('user must be boolean.');
    if ('name' in data) text(data.name,40,'Display name');
    ['rsvps','joined','follows','saved','practitionerFollows'].forEach(k => {if(k in data) stringArray(data[k],1000,120,k);});
    if ('memberProfile' in data) {
      const p = data.memberProfile; object(p,['bio','location','interests'],'Member profile');
      if ('bio' in p) text(p.bio,600,'Profile bio');
      if ('location' in p) text(p.location,100,'Profile location');
      if ('interests' in p) {
        if(typeof p.interests === 'string') text(p.interests,200,'Profile interests');
        else {stringArray(p.interests,12,200,'Profile interests'); if(p.interests.reduce((sum,v)=>sum+[...v].length,0)>200) fail('Profile interests exceed 200 characters.');}
      }
    }
    if ('extraEvents' in data) {array(data.extraEvents,200,'Extra events'); data.extraEvents.forEach(v=>event(v,false));}
    if ('draft' in data && data.draft !== null) event(data.draft,true);
    if ('extraTopics' in data) {
      array(data.extraTopics,200,'Extra discussions');
      data.extraTopics.forEach(t => {
        const limits={id:120,title:140,body:1800,category:80,scope:120,author:40};
        object(t,[...Object.keys(limits),'replies'],'Discussion');
        if(['id','title','body','category','author'].some(k=>!(k in t))) fail('Discussion fields are missing.');
        Object.keys(limits).forEach(k=>{if(k in t)text(t[k],limits[k],'Discussion '+k);});
        if('replies' in t){array(t.replies,200,'Discussion replies');t.replies.forEach(reply);}
      });
    }
    if ('extraReplies' in data) {
      const replies=data.extraReplies;
      if(!replies || typeof replies!=='object' || Array.isArray(replies) || Object.keys(replies).length>200) fail('Invalid extra replies.');
      Object.entries(replies).forEach(([id,values])=>{text(id,120,'Discussion ID');array(values,200,'Discussion replies');values.forEach(reply);});
    }
    if(new TextEncoder().encode(JSON.stringify(data)).length>MAX_BYTES)fail('Workspace data exceeds 1 MiB.');
    return data;
  }
  function project(source) {
    if(!source || typeof source!=='object' || Array.isArray(source)) fail('Workspace state must be an object.');
    const out=defaults();
    KEYS.forEach(k=>{if(Object.prototype.hasOwnProperty.call(source,k) && source[k]!==undefined)out[k]=source[k];});
    if(out.memberProfile===null)out.memberProfile={};
    validate(out); return clone(out);
  }
  function canonical(value) {
    if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
    if(value && typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
    return JSON.stringify(value);
  }
  let current=defaults(), revision=null, pending=false, mode='device', error='', key=null;
  let started=false, disabled=false, conflict=false, change=0, timer=null, work=Promise.resolve();
  let remoteCallback=()=>{}, statusCallback=()=>{}, waiters=[], recovered=null;
  function status(){return {mode,pending,revision,error};}
  function notify(next,reason=''){mode=next;error=reason;try{statusCallback(status());}catch(_){}return status();}
  function metadata(){try{global.localStorage.setItem(META_NAME,JSON.stringify({revision,pending}));}catch(_){} }
  function settle(){const list=waiters;waiters=[];list.forEach(resolve=>resolve(status()));}
  function serialize(fn){const result=work.then(fn,fn);work=result.catch(()=>{});return result;}
  function workspaceKey(){
    const stored=global.localStorage.getItem(KEY_NAME);
    if(stored && /^[a-fA-F0-9]{64}$/.test(stored))return stored.toLowerCase();
    const bytes=new Uint8Array(32);global.crypto.getRandomValues(bytes);
    const generated=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
    global.localStorage.setItem(KEY_NAME,generated);
    if(global.localStorage.getItem(KEY_NAME)!==generated)fail('Workspace key could not be saved on this device.');
    global.localStorage.removeItem(META_NAME);return generated;
  }
  async function request(path,method='GET',body){
    const controller=new AbortController(), timeout=setTimeout(()=>controller.abort(),8000);
    try{
      const response=await global.fetch(path,{method,credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,headers:path==='/api/health'?{}:{'X-CircleUp-Workspace':key,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
      if(response.status===404){disabled=true;const e=new Error('This host has no storage API.');e.disabled=true;throw e;}
      if(response.status===409){const e=new Error('Saved copy changed. Your local changes are preserved.');e.conflict=true;throw e;}
      if(!response.ok)fail('Storage request failed ('+response.status+').');
      const raw=await response.text();
      if(new TextEncoder().encode(raw).length>MAX_BYTES)fail('Storage response exceeds 1 MiB.');
      return JSON.parse(raw);
    }finally{clearTimeout(timeout);}
  }
  function record(value){
    object(value,['schemaVersion','revision','data'],'Storage response');
    if(value.schemaVersion!==VERSION || !Number.isSafeInteger(value.revision) || value.revision<0 || !('data' in value))fail('Unsupported storage response.');
    const empty=value.revision===0 && value.data && typeof value.data==='object' && !Array.isArray(value.data) && Object.keys(value.data).length===0;
    validate(value.data);return {revision:value.revision,data:project(value.data),empty};
  }
  function acceptRemote(r,apply){
    revision=r.revision;current=clone(r.data);pending=false;conflict=false;metadata();
    if(apply)remoteCallback(clone(current));
    notify('synced');
  }
  function markConflict(){conflict=true;pending=true;metadata();return notify('conflict','Saved copy changed. Local changes are preserved; export them before loading the saved copy.');}
  function deviceFailure(e){if(e.conflict)return markConflict();pending=true;metadata();return notify(e.disabled?'disabled':'device',e.disabled?'This host has no storage API. Your device copy and backups still work.':'Storage unavailable. Your changes remain on this device.');}
  async function writePending(){
    if(disabled || conflict || revision===null)return status();
    while(pending && !disabled && !conflict){
      const snapshot=clone(current), seq=change, expected=revision;notify('saving');
      const saved=record(await request('/api/v1/workspace','PUT',{schemaVersion:VERSION,expectedRevision:expected,data:snapshot}));
      if(saved.revision!==expected+1 || canonical(saved.data)!==canonical(snapshot))fail('Storage did not acknowledge the queued data.');
      revision=saved.revision;pending=change!==seq;metadata();
    }
    return notify('synced');
  }
  async function refresh(kind){
    if(disabled)return status();
    if(conflict && kind!=='pull')return status();
    const seq=change, previous=revision;notify('connecting');
    await request('/api/health');
    const r=record(await request('/api/v1/workspace'));
    const edited=change!==seq;
    if(kind==='pull'){
      if(edited)return markConflict();
      acceptRemote(r,true);return status();
    }
    if(!r.empty && canonical(r.data)===canonical(current)){acceptRemote(r,false);return status();}
    if(kind==='init' && !edited && !recovered?.pending && !r.empty){acceptRemote(r,true);return status();}
    if(!r.empty && (previous===null || r.revision!==previous))return markConflict();
    revision=r.revision;pending=true;metadata();return writePending();
  }
  function queueAttempt(refreshFirst=false){return serialize(async()=>{try{if(disabled || conflict)return status();return await (refreshFirst || revision===null?refresh('retry'):writePending());}catch(e){return deviceFailure(e);}finally{settle();}});}
  function save(data){
    if(!started)return Promise.reject(new Error('Initialize CircleUpStorage before saving.'));
    let next;try{next=project(data);}catch(e){return Promise.reject(e);}
    if(canonical(next)===canonical(current))return Promise.resolve(status());
    current=next;change++;pending=true;metadata();
    notify(conflict?'conflict':disabled?'disabled':'device',conflict?error:'');
    clearTimeout(timer);
    const result=new Promise(resolve=>waiters.push(resolve));
    timer=setTimeout(()=>{timer=null;queueAttempt();},DEBOUNCE_MS);return result;
  }
  function init(initialData,onRemote,onStatus){
    if(started)return Promise.reject(new Error('CircleUpStorage is already initialized.'));
    current=project(initialData||{});remoteCallback=typeof onRemote==='function'?onRemote:()=>{};statusCallback=typeof onStatus==='function'?onStatus:()=>{};started=true;
    try{key=workspaceKey();try{const meta=JSON.parse(global.localStorage.getItem(META_NAME)||'null');if(meta && typeof meta.pending==='boolean' && (meta.revision===null || Number.isSafeInteger(meta.revision)&&meta.revision>=0))recovered=meta;}catch(_){}if(recovered?.pending){revision=recovered.revision;pending=true;}}
    catch(e){disabled=true;pending=true;return Promise.resolve(notify('device','A durable workspace key is unavailable. Device storage and backups still work.'));}
    return serialize(async()=>{try{return await refresh('init');}catch(e){return deviceFailure(e);}finally{settle();}});
  }
  function retry(){if(!started)return Promise.reject(new Error('Initialize CircleUpStorage first.'));clearTimeout(timer);timer=null;return queueAttempt(true);}
  function pull(){
    if(!started)return Promise.reject(new Error('Initialize CircleUpStorage first.'));
    clearTimeout(timer);timer=null;
    return serialize(async()=>{try{return await refresh('pull');}catch(e){return deviceFailure(e);}finally{settle();}});
  }
  function exportBackup(data){
    const backup={schemaVersion:VERSION,exportedAt:new Date().toISOString(),data:project(data)};
    const raw=JSON.stringify(backup,null,2);
    if(new TextEncoder().encode(raw).length>MAX_BYTES)fail('Backup exceeds 1 MiB.');
    const blob=new Blob([raw],{type:'application/json'}), url=global.URL.createObjectURL(blob), a=global.document.createElement('a');
    a.href=url;a.download='circleup-backup-v1-'+new Date().toISOString().slice(0,10)+'.json';a.style.display='none';
    global.document.body.appendChild(a);a.click();a.remove();setTimeout(()=>global.URL.revokeObjectURL(url),1000);
    return backup;
  }
  async function readBackup(file){
    if(!file || typeof file.text!=='function' || !Number.isFinite(file.size) || file.size<0 || file.size>MAX_BYTES)fail('Choose a JSON backup no larger than 1 MiB.');
    const raw=await file.text();if(new TextEncoder().encode(raw).length>MAX_BYTES)fail('Backup exceeds 1 MiB.');
    let backup;try{backup=JSON.parse(raw);}catch(_){fail('Backup must be valid JSON.');}
    safeTree(backup);object(backup,['schemaVersion','exportedAt','data'],'Backup');
    if(backup.schemaVersion!==VERSION || !('data' in backup))fail('Unsupported backup version.');
    if('exportedAt' in backup)text(backup.exportedAt,40,'Export date');
    validate(backup.data);return project(backup.data);
  }
  global.CircleUpStorage=Object.freeze({init,save,status,pull,retry,exportBackup,readBackup,project});
  global.addEventListener('online',()=>{if(started && pending && !conflict && !disabled)queueAttempt(true);});
})(window);
