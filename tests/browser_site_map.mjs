import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';

const out=process.env.RAQEEB_QA_OUTPUT || join(tmpdir(),'raqeeb-browser-qa');
await mkdir(out,{recursive:true});
const target=process.env.RAQEEB_QA_URL || 'http://127.0.0.1:8002';
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
  await until('typeof D !== "undefined" && D.connected && D.analyses.has("CAM-01") && D.analyses.has("CAM-03")');
  await until('document.querySelectorAll("video[data-camera]").length===2 && [...document.querySelectorAll("video[data-camera]")].every(v=>v.readyState>=2)');
  await evaluate('Promise.all([...document.querySelectorAll("video[data-camera]")].map(v=>v.play()))');
  await sleep(600);
  await evaluate('[...document.querySelectorAll("video[data-camera]")].forEach(v=>v.pause())');
  await until('D.frames.get("CAM-03")?.dets?.length && SiteMap3D.scene && SiteMap3D.tracking.people.length>1');
  await evaluate('document.fonts.ready');
  assert.equal(await evaluate('SiteMap3D.scene.cameras.length'),6);
  const summary=await evaluate('({people:SiteMap3D.tracking.people.length,markers:SiteMap3D.markers.map(m=>({id:m.id,kind:m.kind,alert:m.alert})),pids:SiteMap3D.tracking.people.map(m=>m.id)})');
  assert.equal(new Set(summary.pids).size,summary.pids.length);
  assert(summary.markers.some(m=>m.alert),'Existing open incidents must appear red');
  console.log('Mapped current real detections and open incidents:',JSON.stringify(summary));
  await evaluate('document.querySelector(".site-map-card").scrollIntoView({block:"center"})');
  const before=await evaluate('document.querySelector("[data-role=site-map] canvas").toDataURL()');
  await sleep(230);
  const after=await evaluate('document.querySelector("[data-role=site-map] canvas").toDataURL()');
  assert.notEqual(before,after,'Red incident pulse must redraw when the map is not rotating');
  const shot=await cdp('Page.captureScreenshot',{format:'png'});
  await writeFile(join(out,'raqeeb-3d-map.png'),Buffer.from(shot.data,'base64'));
  await evaluate("SiteMap3D.setView('top')");await sleep(120);
  assert.notEqual(await evaluate('document.querySelector("[data-role=site-map] canvas").toDataURL()'),after);
  const canvasBefore=await evaluate('document.querySelector("[data-role=site-map] canvas").toDataURL()');
  await evaluate('document.querySelector("[data-role=site-map] canvas").focus()');
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowLeft',code:'ArrowLeft'});
  await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowLeft',code:'ArrowLeft'});
  await sleep(80);
  assert.notEqual(await evaluate('document.querySelector("[data-role=site-map] canvas").toDataURL()'),canvasBefore,'Keyboard orbit must work');
  await evaluate("SiteMap3D.setView('top')");await sleep(80);
  const selectable=await evaluate('(()=>{const c=document.querySelector("[data-role=site-map] canvas"),r=c.getBoundingClientRect();const m=SiteMap3D.markers.find(m=>m.kind==="person"&&m.screen&&m.screen[0]>400&&m.screen[1]>170&&m.screen[1]<r.height-80);return m?{id:m.id,x:r.left+m.screen[0],y:r.top+m.screen[1]}:null})()');
  assert(selectable,'A real person dot must be visible for picking');
  await cdp('Input.dispatchMouseEvent',{type:'mousePressed',x:selectable.x,y:selectable.y,button:'left',clickCount:1});
  await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x:selectable.x,y:selectable.y,button:'left',clickCount:1});
  await until('document.querySelector(".map-person-detail")');
  await evaluate('document.querySelector(".map-person-detail [data-person]").click()');
  await until('document.querySelector(".person-profile img").naturalWidth>0');
  await evaluate('closeM()');
  await evaluate('(()=>{const select=document.querySelector("[data-bind-source]");select.value="CAM-06";select.dispatchEvent(new Event("change",{bubbles:true}));})()');
  await evaluate("go('overview')");
  await until('SiteMap3D.mounted && document.querySelector("[data-bind-source]")?.value==="CAM-06"');
  assert(await evaluate('document.body.innerText.includes("Not calibrated")'),'Approximate placement must be disclosed');
  const ids=await evaluate('D.incidents.filter(active).map(e=>({id:e.id,status:e.status}))');
  for(const [index,event] of ids.entries())await evaluate(`setSt('${event.id}','${index%2?'False Positive':'Resolved'}')`);
  await evaluate('SiteMap3D.refresh()');
  await until('SiteMap3D.markers.every(m=>!m.alert)');
  await evaluate("go('people')");
  assert.equal(await evaluate('SiteMap3D.mounted'),false,'Leaving map screens must stop rendering');
  await evaluate("go('overview')");await until('SiteMap3D.mounted');
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await sleep(200);
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false,'Map must fit mobile width');
  await evaluate('toggleLang()');
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false,'Map must fit Arabic mobile width');
  await evaluate('toggleLang();toggleTheme()');
  assert.equal(await evaluate('document.documentElement.dataset.theme'),'light');
  await evaluate('toggleTheme()');
  assert.equal(errors.length,0,JSON.stringify(errors));
  console.log('Passed real marker deduplication, animated incidents, picking/snapshots, webcam placement persistence, resolution/false-positive transitions, lifecycle, theme, and mobile/RTL.');
  for(const event of ids)await evaluate(`setSt('${event.id}','${event.status}')`);
  await cdp('Browser.close');
} finally {ws?.close();if(chrome.exitCode===null)chrome.kill();}
