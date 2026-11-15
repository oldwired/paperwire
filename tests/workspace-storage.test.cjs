const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {launchBrowser}=require('./helpers/browser.cjs');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8')
  .replace('\n})();','\nwindow.__test={run:source=>eval(source)};\n})();');
// Simulate the former app's storage names at exactly the same origin and pathname.
const simpleCanvasHtml=html.replaceAll('paperwire:','simplecanvas:')
  .replaceAll('PaperwireWorkspaces','SimpleCanvasWorkspaces').replaceAll('PaperwireLibrary','SimpleCanvasLibrary');
const engine=process.env.BROWSER_ENGINE||'chromium';
let browser;
before(async()=>{browser=await launchBrowser({engine});});
after(async()=>{await browser?.close();});
const box={type:'rect',uid:'box',x:80,y:90,w:150,h:100,color:'#1f2937',size:2,fill:true,fillColor:'#ffd166'};
async function app(fn,{init}={}){
  const context=await browser.newContext({viewport:{width:1280,height:900}}),errors=[];
  try{
    if(init)await context.addInitScript(init);
    await context.route('http://localhost:4173/**',route=>route.fulfill({status:route.request().url().includes('.html')?200:404,contentType:'text/html',body:route.request().url().includes('.html')?(route.request().url().includes('storage=simplecanvas')?simpleCanvasHtml:html):''}));
    const open=async(file='index.html')=>{
      const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
      await page.goto('http://localhost:4173/'+file);
      const run=source=>page.evaluate(async source=>{await __test.run('appReady');return __test.run(source);},source);
      await run('appStarted');return {page,run};
    };
    await fn({...(await open()),open,context,errors});assert.deepEqual(errors,[],'no uncaught application errors');
  }finally{await context.close();}
}
const seed=async(run,x=80)=>run(`applySketchToActiveTab([{...${JSON.stringify(box)},x:${x}}],{});persistWorkspace()`);
const owner=run=>run('({owned:workspaceStorage.owned,writable:workspaceStorage.writable,protected:workspaceStorage.protected,error:workspaceStorage.error})');
const saved=run=>run('readSavedWorkspace()');
const waitReadOnly=page=>page.waitForFunction(()=>__test.run('workspaceStorage.ready && !workspaceStorage.writable'));

test('workspace snapshots use IndexedDB when localStorage writes are disabled and survive reload',async()=>app(async({page,run})=>{
  assert.equal((await owner(run)).owned,true);assert.equal(await seed(run),true);
  const initial=await saved(run);assert.equal(initial.workspace.tabs[0].document.items[0].x,80);
  assert.equal(await page.evaluate(()=>localStorage.getItem('paperwire:tabs:v1')),null);
  await run('newTab();persistWorkspace()');assert.equal((await saved(run)).workspace.tabs.length,2);
  await page.reload();assert.equal(await run('tabs.length'),2);await run('activateTab(tabs[0].id)');assert.equal(await run('items[0].uid'),'box');
},{init:()=>{Storage.prototype.setItem=function(){throw new DOMException('disabled','QuotaExceededError');};}}));

test('a workspace larger than localStorage quota remains durable with its image data',async()=>app(async({page,run})=>{
  const size=await run(`(async()=>{
    const image=document.createElement('canvas');image.width=image.height=1600;
    const ctx=image.getContext('2d'),pixels=ctx.createImageData(1600,1600);crypto.getRandomValues(pixels.data.subarray(0,65536));
    for(let offset=65536;offset<pixels.data.length;offset+=65536)crypto.getRandomValues(pixels.data.subarray(offset,Math.min(offset+65536,pixels.data.length)));
    ctx.putImageData(pixels,0,0);const src=image.toDataURL('image/png');
    applySketchToActiveTab([{type:'image',uid:'photo',id:'photo',x:0,y:0,w:400,h:400,rotation:0}],{photo:src});await persistWorkspace();return src.length;
  })()`);
  assert.ok(size>5*1024*1024);assert.equal((await owner(run)).error,'');
  await page.reload();assert.equal(await run('assets.photo.length'),size);assert.equal(await run('items[0].uid'),'photo');
}));

test('rapid edits during a pending snapshot are flushed before persistWorkspace resolves',async()=>app(async({run})=>{
  await seed(run);
  const result=await run(`(async()=>{
    const original=IDBObjectStore.prototype.put;let changed=false;
    IDBObjectStore.prototype.put=function(value,key){
      const request=original.call(this,value,key);
      if(this.name==='workspaces'&&!changed){changed=true;queueMicrotask(()=>{items[0].x=170;save();});}
      return request;
    };
    items[0].x=120;try{await save();return {live:items[0].x,stored:(await readSavedWorkspace()).workspace.tabs[0].document.items[0].x,dirty:unsavedTabs.size};}
    finally{IDBObjectStore.prototype.put=original;}
  })()`);
  assert.deepEqual(result,{live:170,stored:170,dirty:0});
}));

test('second window is read-only; explicit takeover loads the latest workspace and fences the former writer',async()=>app(async({page,run,open})=>{
  await seed(run,90);const other=await open();assert.equal((await owner(other.run)).writable,false);
  assert.equal(await other.run('items[0].x'),90);await run('items[0].x=140;save()');
  await other.page.locator('#canvas').click({position:{x:400,y:400}});await other.page.keyboard.press('Delete');
  assert.equal(await other.run('items.length'),1);assert.equal(await other.run('newTab();tabs.length'),1);
  await other.page.locator('#takeWorkspaceOwnership').click();
  await other.page.waitForFunction(()=>__test.run('workspaceStorage.writable && items[0]?.x===140'));
  await waitReadOnly(page);assert.equal((await owner(run)).writable,false);
  await other.run('items[0].x=210;save()');const durable=await saved(other.run);
  assert.equal(await run('items[0].x=500;save()'),false);assert.deepEqual(await saved(run),durable);
  await other.page.reload();assert.equal(await other.run('items[0].x'),210);assert.equal((await owner(other.run)).writable,true);
}));

test('corrupt snapshots are preserved read-only and can be downloaded before explicit recovery',async()=>app(async({page,run})=>{
  await seed(run);const corrupt={version:1,revision:'broken',workspace:{tabs:[{id:'broken',name:'Broken',document:{items:[{type:'unknown'}]}}],activeId:'broken'}};
  await run(`(async()=>{const db=await openWorkspaceDatabase();await new Promise((resolve,reject)=>{const tx=db.transaction('workspaces','readwrite');tx.objectStore('workspaces').put(${JSON.stringify(corrupt)},WORKSPACE_STORAGE_KEY);tx.oncomplete=resolve;tx.onabort=reject;});})()`);
  await page.reload();assert.equal((await owner(run)).protected,true);assert.equal((await owner(run)).writable,false);
  assert.deepEqual(await saved(run),corrupt);await run('save()');assert.deepEqual(await saved(run),corrupt);
  const downloadPromise=page.waitForEvent('download');await page.locator('#downloadWorkspaceRecovery').click();
  const download=await downloadPromise;assert.deepEqual(JSON.parse(fs.readFileSync(await download.path(),'utf8')),corrupt);
  await page.locator('#resetWorkspaceRecovery').click();await page.waitForFunction(()=>__test.run('workspaceStorage.writable && !workspaceStorage.protected && !workspaceStorage.job'));
  assert.equal((await saved(run)).workspace.tabs[0].document.items.length,0);
  const recovery=await run(`(async()=>{const db=await openWorkspaceDatabase();return new Promise(resolve=>{const tx=db.transaction('recovery'),request=tx.objectStore('recovery').getAll();tx.oncomplete=()=>resolve(request.result);});})()`);
  assert.deepEqual(recovery,[corrupt]);
}));

test('malformed legacy storage is preserved instead of replaced with a blank autosave',async()=>app(async({page,run})=>{
  assert.equal((await owner(run)).protected,true);assert.equal(await saved(run),null);
  assert.equal(await page.evaluate(()=>localStorage.getItem('paperwire:tabs:v1')),'{broken');
  await run('save()');assert.equal(await saved(run),null);
},{init:()=>localStorage.setItem('paperwire:tabs:v1','{broken')}));

test('direct file URLs retain autosave and single-owner behavior without a server',async()=>{
  const os=require('node:os'),{pathToFileURL}=require('node:url');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'simplecanvas-storage-')),file=path.join(directory,'index.html');
  fs.writeFileSync(file,html);const context=await browser.newContext();
  try{
    const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
    await page.goto(pathToFileURL(file).href);const run=source=>page.evaluate(async source=>{await __test.run('appReady');return __test.run(source);},source);
    await seed(run,370);assert.equal((await owner(run)).writable,true);assert.equal((await owner(run)).error,'');
    await page.reload();assert.equal(await run('items[0].x'),370);assert.equal((await owner(run)).writable,true);
    const other=await context.newPage();await other.goto(pathToFileURL(file).href);
    await other.evaluate(()=>__test.run('appReady'));assert.equal(await other.evaluate(()=>__test.run('workspaceStorage.writable')),false);
    await other.close();assert.deepEqual(errors,[]);
  }finally{await context.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('legacy documents without their index remain recoverable instead of starting a new saved workspace',async()=>app(async({page,run})=>{
  assert.equal((await owner(run)).protected,true);assert.equal(await saved(run),null);
  const recovery=await run('workspaceStorage.raw');assert.equal(recovery.documents.orphan,'{"version":2,"items":[]}');
  assert.equal(await page.evaluate(()=>localStorage.getItem('paperwire:doc:orphan')),recovery.documents.orphan);
},{init:()=>localStorage.setItem('paperwire:doc:orphan','{"version":2,"items":[]}')}));

for(const stage of ['database','lock']){
  test(`a cached page hidden while its ${stage} claim is pending cannot become an owner afterward`,async()=>app(async({page,run,open})=>{
    await seed(run,510);const before=await saved(run);
    await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
    await run(`
      window.originalClaim=claimWorkspaceOwnership;
      claimWorkspaceOwnership=(...args)=>(window.pendingClaim=originalClaim(...args));
      window.originalClaimStage=${stage==='database'?'openWorkspaceDatabase':'acquireWorkspaceLock'};
      ${stage==='database'?'openWorkspaceDatabase':'acquireWorkspaceLock'}=async(...args)=>{
        const result=await originalClaimStage(...args);
        ${stage==='database'?'openWorkspaceDatabase':'acquireWorkspaceLock'}=originalClaimStage;
        await new Promise(resolve=>window.finishClaimStage=resolve);return result;
      };
      window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
    `);
    await page.waitForFunction(()=>typeof window.finishClaimStage==='function');
    if(stage==='lock')assert.equal(await run("typeof workspaceStorage.release"),'function','the test holds an actual acquired Web Lock');
    await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
    assert.equal(await run('finishClaimStage();pendingClaim'),false);
    assert.deepEqual(await run('({owned:workspaceStorage.owned,writable:workspaceStorage.writable,suspended:workspaceStorage.suspended,lock:workspaceStorage.release,heartbeat:workspaceStorage.heartbeat})'),
      {owned:false,writable:false,suspended:true,lock:null,heartbeat:null});
    assert.deepEqual(await saved(run),before,'the abandoned claim does not change the workspace');
    const other=await open();assert.equal((await owner(other.run)).writable,true,'the abandoned claim leaves no lock or lease blocking the next window');
  }));
}

for(const operation of ['resume','takeover','retry','recovery']){
  test(`departure during the pending save before ${operation} prevents a later ownership claim`,async()=>app(async({page,run,open})=>{
    await seed(run,540);const before=await saved(run);
    await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
    await run(`
      window.claimCalls=0;window.originalClaim=claimWorkspaceOwnership;
      claimWorkspaceOwnership=(...args)=>{claimCalls++;return window.pendingClaim=originalClaim(...args);};
      workspaceStorage.job=window.pendingSave=new Promise(resolve=>window.finishPendingSave=()=>{workspaceStorage.job=null;resolve(true);});
      ${operation==='resume'?"window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));":
        `window.pendingOperation=${{takeover:'takeWorkspaceOwnership',retry:'retryWorkspaceStorage',recovery:'resetWorkspaceRecovery'}[operation]}();`}
      undefined
    `);
    await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
    await run('finishPendingSave();pendingSave');await run('window.pendingOperation');await run('window.pendingClaim');
    assert.equal(await run('claimCalls'),0,'the pre-departure operation never starts a fresh claim');
    assert.deepEqual(await run('({owned:workspaceStorage.owned,writable:workspaceStorage.writable,suspended:workspaceStorage.suspended})'),
      {owned:false,writable:false,suspended:true});
    assert.deepEqual(await saved(run),before);
    const other=await open();assert.equal((await owner(other.run)).writable,true);
  }));
}


test('Paperwire isolates saved work, libraries and editing ownership from SimpleCanvas at the same browser path',async()=>app(async({page,run,open})=>{
  assert.equal(await run('items.length'),0,'SimpleCanvas legacy storage must not be imported automatically');
  const old=await open('index.html?storage=simplecanvas');
  assert.equal(await old.run('items[0].x'),310,'the former app retains its own legacy data');
  assert.equal((await owner(run)).writable,true);assert.equal((await owner(old.run)).writable,true);
  await seed(run,80);await seed(old.run,310);
  const setLibrary=async(execute,name)=>execute(`(async()=>{
    await restoreShapeLibrary();
    shapeLibrary=prepareShapeLibrary({shapes:[{id:'personal-box',name:${JSON.stringify(name)},items:[${JSON.stringify(box)}]}]});
    shapeLibraryRevision++;queueShapeLibrarySave();return persistShapeLibrary();
  })()`);
  assert.equal(await setLibrary(run,'Paperwire box'),true);
  assert.equal(await setLibrary(old.run,'SimpleCanvas box'),true);
  await page.reload();await old.page.reload();
  assert.equal(await run('items[0].x'),80);assert.equal(await old.run('items[0].x'),310);
  await run('restoreShapeLibrary()');await old.run('restoreShapeLibrary()');
  assert.equal(await run('shapeLibrary.shapes[0].name'),'Paperwire box');
  assert.equal(await old.run('shapeLibrary.shapes[0].name'),'SimpleCanvas box');
  await run('applySketchToActiveTab([],{});persistWorkspace()');await setLibrary(run,'New Paperwire box');
  await old.page.reload();
  assert.equal(await old.run('items[0].x'),310,'clearing Paperwire does not clear SimpleCanvas');
  await old.run('restoreShapeLibrary()');assert.equal(await old.run('shapeLibrary.shapes[0].name'),'SimpleCanvas box');
  assert.equal(await page.evaluate(()=>localStorage.getItem('simplecanvas:v1')),JSON.stringify({version:2,items:[{...box,x:310}],assets:{}}));
},{init:()=>localStorage.setItem('simplecanvas:v1',JSON.stringify({version:2,items:[{type:'rect',uid:'box',x:310,y:90,w:150,h:100,color:'#1f2937',size:2,fill:true,fillColor:'#ffd166'}],assets:{}}))}));
