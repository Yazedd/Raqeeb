import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';

const out=process.env.RAQEEB_QA_OUTPUT || join(tmpdir(),'raqeeb-browser-qa');
await mkdir(out,{recursive:true});
const target=process.env.RAQEEB_QA_URL || 'http://127.0.0.1:8001';
const profile=join(tmpdir(),`raqeeb-monitoring-qa-${Date.now()}`);
await mkdir(profile,{recursive:true});
const chrome=spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',[
  '--headless','--disable-gpu','--no-first-run','--no-default-browser-check',
  '--remote-debugging-port=9237',`--user-data-dir=${profile}`,'--window-size=1917,1182','about:blank'
],{windowsHide:true,stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let ws;
try {
  let tab;
  for(let i=0;i<40;i++) {
    try { tab=await (await fetch('http://127.0.0.1:9237/json/new?'+encodeURIComponent(target),{method:'PUT'})).json(); break; } catch {await sleep(250);}
  }
  assert(tab,'Chrome debugging endpoint did not start');
  ws=new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  let seq=0; const pending=new Map(), errors=[];
  ws.addEventListener('message',event=>{
    const message=JSON.parse(event.data);
    if(message.id) {const p=pending.get(message.id); if(p){pending.delete(message.id);message.error ? p.reject(message.error) : p.resolve(message.result);}}
    else if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails);
  });
  const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{
    const result=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until=async (expression,timeout=30000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await evaluate(expression))return;await sleep(300);}throw new Error('Timed out: '+expression);};
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await until('typeof D !== "undefined" && D.cameras.filter(c=>c.source_type!=="webcam").length === 2 && D.analyses.has("CAM-01") && D.analyses.has("CAM-03")',300000);
  await until('document.querySelectorAll("video[data-camera]").length === 2 && [...document.querySelectorAll("video")].every(v=>v.readyState>=2)',30000);
  assert.equal(await evaluate('D.view'),'live');
  assert.deepEqual(await evaluate('D.cameras.filter(c=>c.source_type!=="webcam").map(c=>c.id)'),['CAM-01','CAM-03']);
  assert(await evaluate('tracks().filter(t=>t.class==="person").every(t=>/^P-\\d{4}$/.test(t.track))'),'Person IDs must be independent of camera IDs');
  const detections=await evaluate('[...D.analyses.values()].filter(a=>a.source_type!=="webcam").map(a=>({camera:a.camera,gun:a.events.find(e=>e.class==="gun")}))');
  assert(detections.every(d=>d.gun),'Both remaining videos must have a genuine inferred gun occurrence');
  assert(detections.find(d=>d.camera==='CAM-01').gun.time<10,'CAM-01 recognition must improve on the old 21.5-second detection');
  console.log('Verified camera assignments, independent person IDs, and gun timestamps:',JSON.stringify(detections));
  assert.equal(await evaluate('document.body.innerText.includes("Demo Simulation")'),false);
  const before=await evaluate('[...document.querySelectorAll("video")].map(v=>({id:v.dataset.camera,ready:v.readyState,width:v.videoWidth,duration:v.duration}))');
  console.log('Decoded camera videos:',JSON.stringify(before));
  const people=await evaluate('tracks().filter(t=>t.class==="person")');
  assert.equal(new Set(people.map(t=>t.id)).size,people.length);
  await evaluate("go('people')");
  await until('[...document.querySelectorAll(".person-thumbnail img")].filter(i=>i.getBoundingClientRect().top<innerHeight).every(i=>i.complete && i.naturalWidth>0)');
  await evaluate(`openPerson('${people[0].id}')`);
  await until('document.querySelector(".person-profile img").naturalWidth>0');
  await evaluate('closeM()');
  for(const view of ['overview','alerts','people','cams','inc','evid','ana','health','set','webcam','live']) {
    await evaluate(`go('${view}')`); assert(await evaluate('document.querySelector("#main").innerText.length>20'));
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false,view+' desktop overflow');
    await evaluate('document.fonts.ready'); await sleep(120);
    const viewShot=await cdp('Page.captureScreenshot',{format:'png'});
    await writeFile(join(out,`raqeeb-${view}-desktop.png`),Buffer.from(viewShot.data,'base64'));
    if(view==='overview') {
      assert.equal(await evaluate('document.querySelectorAll(".donut-wrap").length'),3);
      assert.equal(await evaluate('Number(document.querySelector(".donut-value b").textContent)'),people.length);
    }
  }
  await until('document.querySelectorAll("video[data-camera]").length===2 && [...document.querySelectorAll("video")].every(v=>v.readyState>=2)');
  await evaluate('toggleMonitoring()'); await sleep(1200);
  assert(await evaluate('[...document.querySelectorAll("video")].every(v=>!v.paused && v.currentTime>.2)'));
  assert.equal(await evaluate('D.shown.size'),0,'No early background weapon alerts');
  const desktop=await cdp('Page.captureScreenshot',{format:'png'});
  await writeFile(join(out,'raqeeb-monitoring.png'),Buffer.from(desktop.data,'base64'));
  await evaluate('[...document.querySelectorAll("video")].forEach(v=>v.pause())');
  const events=await evaluate('[...D.analyses.values()].filter(a=>a.source_type!=="webcam").flatMap(a=>a.events)');
  assert(events.every(e=>e.class==='gun'),'These clips must not produce the observed false knife alerts');
  const cam03=events.filter(e=>e.camera==='CAM-03');
  assert.equal(new Set(cam03.map(e=>e.person_id)).size,2,'Both CAM-03 gun holders must be recovered');
  for(const [index,threat] of events.entries()) {
    await evaluate(`(()=>{const v=document.querySelector('video[data-camera="${threat.camera}"]');v.playbackRate=.25;v.currentTime=${Math.max(0,threat.time-.06)};return v.play();})()`);
    await until('D.incidents.some(e=>e.id==="'+threat.id+'") && document.body.classList.contains("lockdown")',10000);
    await evaluate('[...document.querySelectorAll("video")].forEach(v=>v.pause())');
    await until('document.querySelector(".evidence-image").complete && document.querySelector(".evidence-image").naturalWidth>0');
    assert.equal(await evaluate('document.querySelector(".weapon-alert .severity-badge").dataset.severity'),'CRITICAL');
    const shot=await cdp('Page.captureScreenshot',{format:'png'});
    await writeFile(join(out,`raqeeb-verified-gun-${index+1}.png`),Buffer.from(shot.data,'base64'));
    await evaluate(`acknowledge('${threat.id}')`);
    await until('!document.body.classList.contains("lockdown")');
  }
  console.log('Verified unique person rows/photos, no early false alerts, two CAM-03 gun holders, and severity/evidence/acknowledgement for every incident.');
  const count=await evaluate('D.incidents.length');
  await evaluate('restartMonitoring()'); await sleep(700);
  assert.equal(await evaluate('D.incidents.length'),count,'Restart must not duplicate saved incidents');
  await evaluate('[...document.querySelectorAll("video")].forEach(v=>v.pause()); D.running=false; toggleLang()');
  assert.equal(await evaluate('document.documentElement.dir'),'rtl');
  await evaluate('toggleLang(); toggleTheme()');
  assert.equal(await evaluate('document.documentElement.dataset.theme'),'light');
  await evaluate('toggleTheme(); toggleChat(); chatSearch("blue")');
  assert(await evaluate('document.querySelector("#chatLog").innerText.length>50'));
  await evaluate('toggleChat()');
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await sleep(300);
  for(const view of ['overview','people','alerts','cams','evid','ana','health','set','webcam','live']) {
    await evaluate(`go('${view}')`); await sleep(70);
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false,view+' mobile overflow');
    if(['overview','people'].includes(view)) {
      const shot=await cdp('Page.captureScreenshot',{format:'png'});
      await writeFile(join(out,`raqeeb-${view}-mobile.png`),Buffer.from(shot.data,'base64'));
    }
  }
  const overflow=await evaluate('document.documentElement.scrollWidth>innerWidth');
  assert.equal(overflow,false,'Mobile view must not overflow horizontally');
  const mobile=await cdp('Page.captureScreenshot',{format:'png'});
  await writeFile(join(out,'raqeeb-monitoring-mobile.png'),Buffer.from(mobile.data,'base64'));
  await evaluate('toggleLang()');
  for(const view of ['overview','live','people','alerts','health','set']) {
    await evaluate(`go('${view}')`);
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false,view+' Arabic mobile overflow');
  }
  await evaluate("toggleLang(); go('overview'); toggleTheme()");
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  const light=await cdp('Page.captureScreenshot',{format:'png'});
  await writeFile(join(out,'raqeeb-overview-light.png'),Buffer.from(light.data,'base64'));
  await evaluate('toggleTheme()');
  assert.equal(errors.length,0,JSON.stringify(errors));
  console.log('Passed navigation, playback, real alert/evidence/persistence, restart, RTL, theme, person search, mobile layout, and runtime error checks.');
  await cdp('Browser.close');
} finally {
  ws?.close();
  if(chrome.exitCode===null)chrome.kill();
}
