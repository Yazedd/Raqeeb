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
  '--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',...(process.env.WEBCAM_TEST_VIDEO ? ['--use-file-for-fake-video-capture='+process.env.WEBCAM_TEST_VIDEO] : []),'--headless','--disable-gpu','--no-first-run','--no-default-browser-check',
  '--remote-debugging-port=9238',`--user-data-dir=${profile}`,'--window-size=1917,1182','about:blank'
],{windowsHide:true,stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let ws;
try {
  let tab;
  for(let i=0;i<40;i++) {
    try { tab=await (await fetch('http://127.0.0.1:9238/json/new?'+encodeURIComponent(target),{method:'PUT'})).json(); break; } catch {await sleep(250);}
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
  await until('typeof D !== "undefined" && D.connected && D.analyses.size>=2');
  assert.equal(await evaluate('W.stream'),null,'Camera must remain off until Start');
  await evaluate("go('webcam')");
  assert.equal(await evaluate('document.querySelector("#webcamStop").disabled'),true);
  await evaluate('startWebcam()');
  await until('W.active && W.last && W.last.samples>=2',90000);
  assert.equal(await evaluate('W.stream.getAudioTracks().length'),0);
  assert(await evaluate('W.last.inference_ms>0 && W.last.inference_fps>0'));
  await until('document.querySelector("#webcamResult").naturalWidth>0');
  if(process.env.WEBCAM_TEST_VIDEO) {
    await until('D.incidents.some(e=>e.camera==="WEB-01") && D.alertOpen',90000);
    const event=await evaluate('D.incidents.find(e=>e.camera==="WEB-01")');
    assert.equal(event.class,'gun'); assert.match(event.person_id,/^P-\d{4,}$/);
    const shot=await cdp('Page.captureScreenshot',{format:'png'});
    await writeFile(join(out,'webcam-confirmed-gun.png'),Buffer.from(shot.data,'base64'));
    await evaluate(`acknowledge('${event.id}')`);
    await until('!D.alertOpen');
    console.log('Actual recognition from webcam test input produced a confirmed gun incident:',event.id,event.person_id);
  }
  const firstPerson=await evaluate('W.last.tracks.find(t=>t.session===W.last.tracks.at(-1).session)?.id');
  if(firstPerson) {
    await evaluate(`go('people');sq('${firstPerson}')`);
    await until('document.querySelector(".person-thumbnail img")?.naturalWidth>0');
    await evaluate(`openPerson('${firstPerson}')`);
    await until('document.querySelector(".person-profile img").naturalWidth>0');
    await evaluate('closeM()');
  }
  const before=await evaluate('W.last.samples');
  await evaluate("go('overview')");
  await until('W.last.samples>'+before,30000);
  await evaluate("go('webcam')");
  await until('document.querySelector("#webcamPreview video").readyState>=2');
  await evaluate('document.fonts.ready');
  const screen=await cdp('Page.captureScreenshot',{format:'png'});
  await writeFile(join(out,'webcam-live.png'),Buffer.from(screen.data,'base64'));
  await evaluate('window.stoppedTracks=W.stream.getTracks();stopWebcam()');
  await until('!W.active && !W.stream && stoppedTracks.every(t=>t.readyState==="ended")');
  await until('(async()=>{const c=await request("/api/cameras");return c.cameras.find(x=>x.id==="WEB-01")?.status==="paused"})()');
  const after=await evaluate('(async()=>{const a=await request("/api/cameras/WEB-01/analysis");return a.samples})()');
  await sleep(1500);
  assert.equal(await evaluate('(async()=>{const a=await request("/api/cameras/WEB-01/analysis");return a.samples})()'),after,'No frames may publish after Stop');
  await evaluate('window.originalCameraAccess=navigator.mediaDevices.getUserMedia;navigator.mediaDevices.getUserMedia=()=>Promise.reject(new DOMException("Denied","NotAllowedError"))');
  await evaluate('startWebcam()');
  assert.equal(await evaluate('W.active'),false);
  assert(await evaluate('W.error.includes("denied")'));
  await evaluate('navigator.mediaDevices.getUserMedia=originalCameraAccess');
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
  await evaluate('toggleLang()');
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
  assert.equal(errors.length,0,JSON.stringify(errors));
  console.log('Passed explicit video-only capture, live inference, person snapshots, cross-view monitoring, Stop, permission denial, and mobile/RTL checks.');
  await cdp('Browser.close');
} finally {
  ws?.close();
  if(chrome.exitCode===null)chrome.kill();
}
