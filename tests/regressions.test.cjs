const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {launchBrowser}=require('./helpers/browser.cjs');
const engine = process.env.BROWSER_ENGINE || 'chromium';
assert.ok(['chromium','webkit'].includes(engine), 'BROWSER_ENGINE must be chromium or webkit');

// Exercise the real single-file app. Expose its closure in the served test copy only;
// geometry, persistence, event handlers, and rendering all remain production code.
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
  .replace('\n})();', '\nwindow.__test = {run: source => eval(source)};\n})();');
let browser;
before(async () => {
  browser = await launchBrowser({engine});
});
after(async () => { if(browser) await browser.close(); });

async function app(fn, options={}){
  const context = await browser.newContext({viewport:{width:1280,height:900}, ...options.context});
  try{
    if(options.init) await context.addInitScript(options.init);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.accept());
    const origin=options.origin || 'http://simplecanvas.test';
    await page.route(origin+'/**', route => {
      const file = options.files?.[route.request().url().slice(origin.length+1)];
      return route.fulfill({
        status:file!==undefined || route.request().url().endsWith('index.html') ? 200 : 404,
        contentType:file!==undefined ? 'application/json' : 'text/html', body:file ?? html
      });
    });
    await page.goto(origin+'/index.html');
    const run = code => page.evaluate(async code => {await window.__test.run('appReady');return window.__test.run(code);}, code);
    await run('appStarted');
    await fn({page, run, context});
    assert.deepEqual(errors, [], 'no uncaught application errors');
  } finally { await context.close(); }
}
const rectangle = (uid='rect') => ({type:'rect',uid,x:100,y:100,w:160,h:100,size:2,
  color:'#1f2937',strokeOn:true,fill:true,fillColor:'#ffd166'});
async function downloadedJSON(page, run, expression){
  const download = page.waitForEvent('download');
  await run(expression);
  return JSON.parse(fs.readFileSync(await (await download).path(), 'utf8'));
}
async function downloadedHTML(page, run){
  const download=page.waitForEvent('download');await run('exportHtml()');
  return fs.readFileSync(await (await download).path(),'utf8');
}
async function savedWorkspace(run){
  await run('persistWorkspace()');
  const record=await run('readSavedWorkspace()');
  assert.ok(record?.workspace?.tabs.length,'a complete workspace is durable in IndexedDB');
  return record;
}
async function failWorkspaceWrites(page){
  await page.evaluate(()=>{
    window.originalWorkspacePut=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(...args){
      if(this.name==='workspaces')throw new DOMException('Full','QuotaExceededError');
      return window.originalWorkspacePut.apply(this,args);
    };
  });
}
async function restoreWorkspaceWrites(page){
  await page.evaluate(()=>{IDBObjectStore.prototype.put=window.originalWorkspacePut;});
}

test('HTML export keeps each tab’s images, group rotation, and pending text edits', async () => app(async ({page,run,context}) => {
  const fixture=await run(`
    const c=document.createElement('canvas');c.width=c.height=30;const cx=c.getContext('2d');
    cx.fillStyle='red';cx.fillRect(0,0,30,30);const red=c.toDataURL();
    cx.fillStyle='blue';cx.fillRect(0,0,30,30);const blue=c.toDataURL();
    const scene=x=>[{type:'image',uid:'image',id:'shared',x,y:100,w:30,h:30},
      {...${JSON.stringify(rectangle('a'))},x,group:'shared-group',groupRotation:.5},
      {...${JSON.stringify(rectangle('b'))},x:x+200,group:'shared-group',groupRotation:.5}];
    applySketchToActiveTab(scene(100),{shared:red});
    newTab();applySketchToActiveTab(scene(500),{shared:blue});
    items.push({...${JSON.stringify(wrappedText)},text:'previous'});openText(3);textInput.value='latest edit';
    ({red,blue});
  `);
  const exported=await downloadedHTML(page,run);
  const preview=await context.newPage();await preview.setContent(exported);
  const panels=preview.locator('.tab-panel');assert.equal(await panels.count(),2);
  for(let i=0;i<2;i++){
    await preview.locator('.tab-select').nth(i).click();
    assert.equal(await panels.nth(i).isVisible(),true);
    assert.equal(await panels.nth(i).locator('image').getAttribute('href'),i===0?fixture.red:fixture.blue);
    const matrices=await panels.nth(i).locator('g[transform^="rotate"]').evaluateAll(groups=>groups.map(g=>{
      const m=g.getCTM();return {a:m.a,b:m.b,e:m.e,f:m.f};
    }));
    assert.equal(matrices.length,2);
    const cx=i===0?280:680, cy=150, c=Math.cos(.5), sin=Math.sin(.5);
    for(const m of matrices){
      assert.ok(Math.abs(m.a-c)<1e-6 && Math.abs(m.b-sin)<1e-6);
      assert.ok(Math.abs(m.e-(cx*(1-c)+cy*sin))<.01 && Math.abs(m.f-(cy*(1-c)-cx*sin))<.01,
        'each exported group rotates around its own tab’s pivot');
    }
  }
  assert.equal((await panels.nth(1).locator('tspan').allTextContents()).join(' '),'latest edit');
  assert.equal(await run('assets[items[0].id]'),fixture.blue,'export leaves the live image intact');
  assert.equal(await run('items[3].text'),'latest edit');
}));

test('copy/paste keeps editable objects before the PNG fallback without internal clipboard state', async () => app(async ({page,run}) => {
  // Capture ClipboardItems without touching the OS clipboard; replay their actual MIME payloads.
  await page.evaluate(()=>{
    window.clipboardWrites=[];
    Object.defineProperty(navigator.clipboard,'write',{value:async entries=>{clipboardWrites.push(entries);}});
  });
  await run(`items=[{...${JSON.stringify(rectangle('a'))},group:'copied',groupRotation:.3},
    {...${JSON.stringify(line)},group:'copied',groupRotation:.3}];setTool('select');selection=[0,1];render();save();`);
  await page.keyboard.press('Control+c');
  const captured=await page.evaluate(async()=>{
    const entry=clipboardWrites.at(-1)[0], text=await(await entry.getType('text/plain')).text(), png=await entry.getType('image/png');
    const bytes=Array.from(new Uint8Array(await png.arrayBuffer()));
    return {text,bytes};
  });
  await run('persistWorkspace()');await page.reload();assert.equal(await run('clipboard.length'),0);
  await page.evaluate(({text,bytes})=>{
    const dt=new DataTransfer();dt.setData('text/plain',text);
    dt.items.add(new File([new Uint8Array(bytes)],'copy.png',{type:'image/png'}));
    window.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,cancelable:true,bubbles:true}));
  },captured);
  assert.deepEqual(await run('items.map(it=>it.type)'),['rect','line','rect','line']);
  assert.equal(await run('items[2].group===items[3].group && items[2].group!==items[0].group'),true);
  assert.equal(await run('items[2].groupRotation'),.3);
  await run('undo()');assert.equal(await run('items.length'),2);
  await run('redo()');assert.equal(await run('items.length'),4);
}, {origin:'http://localhost:8874'}));

test('structured clipboard validates objects and preserves conflicting image assets through undo', async () => app(async ({page,run}) => {
  const fixture=await run(`
    const c=document.createElement('canvas');c.width=c.height=20;const cx=c.getContext('2d');
    cx.fillStyle='red';cx.fillRect(0,0,20,20);const red=c.toDataURL();
    cx.fillStyle='blue';cx.fillRect(0,0,20,20);const blue=c.toDataURL();
    const image={type:'image',uid:'same',id:'shared',x:100,y:100,w:20,h:20};
    applySketchToActiveTab([image],{shared:blue});
    ({red,blue,payload:{app:'SimpleCanvas',kind:'objects',version:2,assets:{shared:red},items:[image,{type:'nonsense'}]}});
  `);
  await page.evaluate(payload=>{
    const dt=new DataTransfer();dt.setData('text/plain',JSON.stringify(payload));
    window.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,cancelable:true,bubbles:true}));
  },fixture.payload);
  assert.deepEqual(await run('items.map(it=>assets[it.id])'),[fixture.blue,fixture.red]);
  assert.equal(await run('items[0].id!==items[1].id && items[0].uid!==items[1].uid'),true);
  await run('undo()');assert.deepEqual(await run('items.map(it=>assets[it.id])'),[fixture.blue]);
  await run('redo()');await run('persistWorkspace()');await page.reload();
  assert.deepEqual(await run('items.map(it=>assets[it.id])'),[fixture.blue,fixture.red]);
}));

test('quota failures preserve tabs, history, JSON/HTML recovery exports, and retry', async () => app(async ({page,run,context}) => {
  await run(`beginHistory();items=[${JSON.stringify(rectangle('before'))}];commitHistory();`);
  const original = await run('activeTabId');
  const durable=await savedWorkspace(run);
  await failWorkspaceWrites(page);
  await run(`beginHistory();items.push(${JSON.stringify(rectangle('after'))});commitHistory();newTab();`);
  await run('persistWorkspace()');
  assert.equal(await page.locator('#autosaveWarning').isVisible(), true);
  assert.deepEqual(await run('readSavedWorkspace()'),durable,'failed writes preserve the entire previous workspace record');
  await run(`activateTab(${JSON.stringify(original)})`);
  assert.deepEqual(await run('items.map(it=>it.uid)'), ['before','after']);
  const exported = await downloadedJSON(page,run,'exportWorkspace()');
  assert.equal(exported.tabs[0].items.length,2);
  assert.equal(exported.tabs.length,2);
  const preview=await context.newPage();await preview.setContent(await downloadedHTML(page,run));
  assert.deepEqual(await preview.locator('.tab-panel').evaluateAll(panels=>panels.map(p=>p.querySelectorAll('svg > g > rect').length)),[2,0],
    'HTML recovery contains unsaved edits and the empty tab');
  await run('undo()'); assert.equal(await run('items.length'),1);
  await run('redo()'); assert.equal(await run('items.length'),2);
  await restoreWorkspaceWrites(page);
  await run('save();persistWorkspace()');
  assert.equal(await page.locator('#autosaveWarning').isVisible(), false);
  await run('persistWorkspace()');await page.reload();
  assert.deepEqual(await run('items.map(it=>it.uid)'), ['before','after']);
}));

test('disabled browser storage still permits drawing, tabs, and workspace export', async () => app(async ({page,run}) => {
  const original=await run('activeTabId');
  await run(`beginHistory();items=[${JSON.stringify(rectangle())}];commitHistory();newTab();activateTab(${JSON.stringify(original)});`);
  assert.equal(await run('items.length'),1);
  assert.equal(await page.locator('#autosaveWarning').isVisible(),true);
  const exported=await downloadedJSON(page,run,'exportWorkspace()');
  assert.equal(exported.tabs[0].items.length,1);
}, {init:() => {
  for(const method of ['getItem','setItem','removeItem']) Storage.prototype[method]=()=>{throw new DOMException('Storage disabled','SecurityError');};
  IDBFactory.prototype.open=()=>{throw new DOMException('Storage disabled','SecurityError');};
}}));

test('large legacy sketches migrate to IndexedDB while retaining the source recovery backup', async () => app(async ({page,run}) => {
  const backup=await page.evaluate(()=>localStorage.getItem('simplecanvas:v1'));
  assert.ok(backup.length>3_000_000);
  assert.equal(await run('items.length'),1);
  assert.equal(await page.locator('#autosaveWarning').isVisible(),false);
  const migrated=await savedWorkspace(run);
  assert.equal(migrated.workspace.tabs[0].document.items[0].id,'large');
  assert.equal(await page.evaluate(()=>localStorage.getItem('simplecanvas:v1')),backup,'migration leaves its legacy recovery source intact');
  await run('save();persistWorkspace()');await run('persistWorkspace()');await page.reload();
  assert.equal(await run('items[0].id'),'large');
}, {init:()=>{
    if(localStorage.getItem('simplecanvas:v1'))return;
    const canvas=document.createElement('canvas');canvas.width=canvas.height=900;
    const ctx=canvas.getContext('2d'), image=ctx.createImageData(900,900);
    let seed=12345;
    for(let i=0;i<image.data.length;i+=4){
      for(let c=0;c<3;c++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;image.data[i+c]=seed>>>24;}
      image.data[i+3]=255;
    }
    ctx.putImageData(image,0,0);
    const data=JSON.stringify({version:2,items:[{type:'image',id:'large',x:100,y:100,w:400,h:400}],assets:{large:canvas.toDataURL()}});
    localStorage.setItem('simplecanvas:v1',data);
}}));

test('workspace replacement atomically retains the old durable workspace until retry succeeds', async () => app(async ({page,run}) => {
  await run(`beginHistory();items=[${JSON.stringify(rectangle('old'))}];commitHistory();`);
  const old=await savedWorkspace(run);
  const workspace={app:'SimpleCanvasWorkspace',version:2,activeIndex:1,tabs:[
    {name:'Imported A',items:[rectangle('a')]},{name:'Imported B',items:[rectangle('b')]}
  ]};
  await failWorkspaceWrites(page);
  await run(`openWorkspaceFile(new File([${JSON.stringify(JSON.stringify(workspace))}],'workspace.json'));`);
  await page.waitForFunction(()=>__test.run('tabs[0].name')==='Imported A');
  assert.deepEqual(await run('items.map(it=>it.uid)'),['b']);
  await run('persistWorkspace()');
  assert.deepEqual(await run('readSavedWorkspace()'),old,'the previous documents and active tab remain one intact record');
  assert.equal(await page.locator('#autosaveWarning').isVisible(),true);
  const exported=await downloadedJSON(page,run,'exportWorkspace()');
  assert.deepEqual(exported.tabs.map(t=>t.items[0].uid),['a','b']);
  await restoreWorkspaceWrites(page);
  await run('save();persistWorkspace()');
  const replacement=await savedWorkspace(run);
  assert.deepEqual(replacement.workspace.tabs.map(tab=>tab.document.items[0].uid),['a','b']);
  assert.equal(replacement.workspace.activeId,replacement.workspace.tabs[1].id);
  assert.ok(replacement.workspace.tabs.every(tab=>!old.workspace.tabs.some(previous=>previous.id===tab.id)));
  assert.equal(await page.locator('#autosaveWarning').isVisible(),false);
  await run('persistWorkspace()');await page.reload();assert.equal(await run('items[0].uid'),'b');
}));

async function insertImage(page,run){
  await run(`const c=document.createElement('canvas');c.width=c.height=40;c.getContext('2d').fillRect(0,0,40,40);importImage(c.toDataURL());`);
  await page.waitForFunction(()=>__test.run('items.length')===1);
}
test('cross-tab image paste survives source closure and destination reload', async () => app(async ({page,run}) => {
  await insertImage(page,run);
  const original=await run('activeTabId'), source=await run('assets[items[0].id]');
  await run(`copySelection();newTab();closeTab(${JSON.stringify(original)});pasteClipboard();`);
  const exported=await downloadedJSON(page,run,'exportWorkspace()');
  assert.equal(exported.tabs[0].assets[exported.tabs[0].items[0].id],source);
  await run('persistWorkspace()');await page.reload();assert.equal(await run('items.length'),1);
  assert.equal(await run('assets[items[0].id]'),source);
}));

test('image import and undo stay with the original tab after switching away', async () => app(async ({page,run}) => {
  // Both calls run in one JS task, before the image load event can fire.
  const original=await run('activeTabId');
  await run(`const c=document.createElement('canvas');c.width=c.height=20;importImage(c.toDataURL());newTab();`);
  await page.waitForFunction(id=>__test.run(`tabDocument(${JSON.stringify(id)}).items.length`)===1,original);
  assert.equal(await run('items.length'),0);
  await run(`activateTab(${JSON.stringify(original)})`);
  assert.equal(await run('items.length'),1);
  const source=await run('assets[items[0].id]');
  await run('undo()');assert.equal(await run('items.length'),0);
  await run('redo()');assert.equal(await run('assets[items[0].id]'),source);
  await run(`setTool('select');selection=[0];deleteSelected();newTab();activateTab(${JSON.stringify(original)});undo();`);
  assert.equal(await run('assets[items[0].id]'),source,'deletion undo restores the image after another tab switch');
  await run('persistWorkspace()');await page.reload();assert.equal(await run('assets[items[0].id]'),source);
}));

const wrappedText={type:'text',uid:'text',x:100,y:320,w:110,h:40,size:2,color:'#000000',
  textColor:'#000000',strokeOn:false,text:'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen',font:'28px Arial',fontSize:28};
const markdownText={...wrappedText,uid:'markdown',y:120,w:140,text:'---\n# Wide heading\none **two** three *four* five six seven eight nine ten eleven twelve\n- thirteen fourteen fifteen sixteen\n---\n[Last link](example.com)'};

test('Markdown PNG, SVG, and clipboard exports contain the full painted block', async () => app(async ({page,run,context}) => {
  await run(`items=[${JSON.stringify(markdownText)}];setTool('select');selection=[];render();`);
  const before=await run('bbox(items[0])');
  const svgDownload=page.waitForEvent('download');await run('saveSvg()');
  const svg=fs.readFileSync(await(await svgDownload).path(),'utf8');
  const preview=await context.newPage();await preview.setContent(svg);
  const bounds=await preview.locator('svg').evaluate(el=>{
    const outer=el.getBoundingClientRect();
    return [...el.querySelectorAll('text,line')].map(child=>{
      const r=child.getBoundingClientRect();return {x:r.x-outer.x,y:r.y-outer.y,right:r.right-outer.x,bottom:r.bottom-outer.y,width:outer.width,height:outer.height};
    });
  });
  for(const b of bounds) assert.ok(b.x>=0 && b.y>=0 && b.right<=b.width && b.bottom<=b.height,'all Markdown text and rules fit the export');
  assert.equal(await preview.locator('a').first().getAttribute('href'),'https://example.com');
  const height=Number(await preview.locator('svg').getAttribute('height'));
  assert.ok(height>400);
  const pngDownload=page.waitForEvent('download');await run('savePng()');
  const png=fs.readFileSync(await(await pngDownload).path());
  assert.ok(png.readUInt32BE(20)>=height*2-2);
  const bluePixels=await page.evaluate(async source=>{
    const image=new Image();image.src=source;await image.decode();
    const c=document.createElement('canvas');c.width=image.width;c.height=image.height;
    const cx=c.getContext('2d');cx.drawImage(image,0,0);const data=cx.getImageData(0,0,c.width,c.height).data;
    let blue=0;for(let i=0;i<data.length;i+=4)if(data[i]<160 && data[i+1]<180 && data[i+2]>200)blue++;
    return blue;
  },'data:image/png;base64,'+png.toString('base64'));
  assert.ok(bluePixels>10,'the final linked text remains visible in PNG');
  const clipboardSize=await run('itemsToPngBlob(items,{background:false}).then(createImageBitmap).then(im=>({width:im.width,height:im.height}))');
  assert.equal(clipboardSize.height,png.readUInt32BE(20));
  assert.deepEqual(await run('bbox(items[0])'),before,'painted extents do not change geometry');
}));

test('actual PNG and SVG exports include the full wrapped text height', async () => app(async ({page,run}) => {
  await run(`items=[${JSON.stringify(wrappedText)}];setTool('select');render();`);
  const before=await run('bbox(items[0])');
  const svgDownload=page.waitForEvent('download');await run('saveSvg()');
  const svg=fs.readFileSync(await (await svgDownload).path(),'utf8');
  const height=Number(/<svg[^>]+height="([^"]+)"/.exec(svg)[1]);
  const baselines=[...svg.matchAll(/<tspan x="[^"]+" y="([^"]+)"/g)].map(m=>Number(m[1]));
  const translateY=Number(/<g transform="translate\([^ ]+ ([^)]+)\)/.exec(svg)[1]);
  assert.ok(baselines.length>10);
  assert.ok(Math.min(...baselines)+translateY>20);
  assert.ok(Math.max(...baselines)+translateY<height-20);
  const pngDownload=page.waitForEvent('download');await run('savePng()');
  const png=fs.readFileSync(await (await pngDownload).path());
  assert.ok(png.readUInt32BE(20)>=height*2-2,'PNG uses the same painted bounds');
  assert.deepEqual(await run('bbox(items[0])'),before,'export leaves geometry bounds unchanged');
}));

const line={type:'line',uid:'line',x1:80,y1:200,x2:320,y2:200,size:6,color:'#000000',dash:'wide'};

test('cycled arrowhead variants survive conversion, undo, reload, and workspace import', async () => app(async ({page,run}) => {
  await run(`items=[${JSON.stringify(line)}];setTool('select');selection=[0];render();`);
  const box=await page.locator('#canvas').boundingBox();
  for(let i=0;i<4;i++) await page.mouse.click(box.x+80,box.y+200);
  for(let i=0;i<2;i++) await page.mouse.click(box.x+320,box.y+200);
  const variants=()=>run(`[headVariantOf(items[0],'start'),headVariantOf(items[0],'end')]`);
  assert.deepEqual(await variants(),['filled-inverted','filled']);
  await run('undo()');assert.deepEqual(await variants(),['filled-inverted','open']);
  await run('redo()');
  await page.mouse.dblclick(box.x+200,box.y+200);
  assert.equal(await run('items[0].type'),'polygon');
  assert.equal(await run('pointEditIdx'),0);
  assert.deepEqual(await variants(),['filled-inverted','filled']);
  await page.mouse.click(box.x+80,box.y+200);
  assert.equal(await run('activeAnchor'),0);
  assert.deepEqual(await variants(),['filled-inverted','filled'],'anchor selection does not cycle heads');
  await page.mouse.dblclick(box.x+200,box.y+200);
  assert.equal(await run('pointEditIdx'),null);
  const workspace=await downloadedJSON(page,run,'exportWorkspace()');
  await run('persistWorkspace()');await page.reload();assert.deepEqual(await variants(),['filled-inverted','filled']);
  const original=await run('({activeTabId,workspaceGeneration})');
  await run(`openWorkspaceFile(new File([${JSON.stringify(JSON.stringify(workspace))}],'variants.json'))`);
  await page.waitForFunction(generation=>__test.run('workspaceGeneration')>generation,original.workspaceGeneration);
  assert.equal(await run('activeTabId'),original.activeTabId,'a whole-workspace reload preserves its sketch identities');
  assert.deepEqual(await variants(),['filled-inverted','filled']);
}));

test('iPad taps cycle endpoints and double-taps enter and leave point editing', async () => app(async ({page,run}) => {
  await run(`items=[${JSON.stringify(line)}];setTool('select');selection=[0];render();`);
  const box=await page.locator('#canvas').boundingBox();
  const head=()=>run(`headsOf(items[0]).e ? headVariantOf(items[0],'end') : 'none'`);
  const tapEnd=()=>page.touchscreen.tap(box.x+320,box.y+215); // finger lands off-center, beyond the mouse radius
  const doubleTapBody=async()=>{
    await page.touchscreen.tap(box.x+200,box.y+200);
    await page.touchscreen.tap(box.x+200,box.y+200);
  };
  await tapEnd();await tapEnd();
  assert.equal(await head(),'filled');
  assert.equal(await run('pointEditIdx'),null,'rapid endpoint taps only cycle heads');
  await doubleTapBody();
  assert.equal(await run('pointEditIdx'),0);
  await tapEnd();await tapEnd();
  assert.equal(await run('pointEditIdx'),0,'rapid anchor taps stay in point editing');
  assert.equal(await run('activeAnchor'),1);
  assert.equal(await head(),'filled','anchor taps do not change arrowheads');
  await doubleTapBody();
  assert.equal(await run('pointEditIdx'),null);
  await tapEnd();
  assert.equal(await head(),'open-inverted','converted curves keep endpoint cycling');
}, {context:{viewport:{width:768,height:1024},hasTouch:true,isMobile:true,deviceScaleFactor:2}}));

// ---------- secondary clicks on the canvas ----------
// The native menu is always suppressed. A secondary press -- the right button, or Control+click on a
// Mac, which browsers deliver as a primary-button press with ctrlKey followed by a contextmenu event
// -- never starts a gesture; its one job is finishing the polygon in progress. Duplicate-drag is
// therefore ⌘+drag on a Mac. Events go straight to the canvas here, so the checks do not depend on
// the host OS's own Control-click handling.
const pointerSequence = (run, seq) => run(`(()=>{
  const r = canvas.getBoundingClientRect();
  let prevented = null;
  for(const [type,x,y,init] of ${JSON.stringify(seq)}){
    const common = {bubbles:true, cancelable:true, clientX:r.left+x, clientY:r.top+y, ...init};
    const e = type==='contextmenu' ? new MouseEvent(type, common) : new PointerEvent(type, {pointerId:1, pointerType:'mouse', ...common});
    canvas.dispatchEvent(e);
    if(type==='contextmenu') prevented = e.defaultPrevented;
  }
  return prevented;
})()`);
const macControlClick = (run, x, y) => pointerSequence(run, [
  ['pointerdown',x,y,{button:0,buttons:1,ctrlKey:true}], ['contextmenu',x,y,{button:2,ctrlKey:true}], ['pointerup',x,y,{button:0,ctrlKey:true}]]);
const modifierDrag = (run, mod, x0, y0, x1, y1) => pointerSequence(run, [
  ['pointerdown',x0,y0,{button:0,buttons:1,[mod]:true}], ['pointermove',(x0+x1)/2,(y0+y1)/2,{buttons:1,[mod]:true}],
  ['pointermove',x1,y1,{buttons:1,[mod]:true}], ['pointerup',x1,y1,{button:0,[mod]:true}]]);

test('on a Mac, Control+click on a selected item duplicates nothing and ⌘+drag is the duplicate-drag; Ctrl+drag stays the duplicate-drag elsewhere', async () => app(async ({page,run}) => {
  await run(`items=[${JSON.stringify(rectangle('r1'))}];setTool('select');selection=[0];render();isMac=true;`);
  assert.equal(await macControlClick(run, 140, 130), true);
  assert.equal(await run('items.length'),1,'no silent duplicate stacked under the (suppressed) menu');
  assert.deepEqual(await run('selection'),[0]);
  await modifierDrag(run, 'metaKey', 140, 130, 200, 170);
  let items=await run('items');
  assert.equal(items.length,2,'⌘+drag duplicated');
  assert.equal(items[0].x,100,'the original stayed');
  assert.ok(Math.abs(items[1].x-160)<.5 && Math.abs(items[1].y-140)<.5,'the copy followed the drag');
  assert.deepEqual(await run('selection'),[1]);

  await run('isMac=false');
  await modifierDrag(run, 'ctrlKey', 200, 170, 260, 170);
  items=await run('items');
  assert.equal(items.length,3,'Ctrl+drag still duplicates on other platforms');
  assert.ok(Math.abs(items[2].x-220)<.5,'the copy followed the drag');
}));

// ---------- group edit mode ("enter group", Point-Edit-style persistence) ----------
// A group's own bounding box, once selected, can be "entered" via double-click (on a member, or on
// empty space between members) -- editingGroupId then names the group, independent of `selection`,
// which is free to become [] (e.g. after deleting the browsed member) or [oneMemberIdx] (that member
// picked for move/resize/recolor/delete/edit) while it stays active. It only exits on a click OUTSIDE
// the group's own box, Escape, Ungroup, or the group vanishing (see groupBoxContains()/syncGroupEdit()).
// hitTest()/hitStack() treat ANY point inside a group's own box as a hit on its topmost (z-order)
// member, even across gaps between members -- exactly like a single item's own bbox is already fully
// clickable, empty interior included. So a click/dblclick on empty space between members always
// resolves to that representative member, never to "nothing" -- there is no separate "missed every
// member, but still inside the box" state to track.
const groupMember = (uid,x) => ({type:'rect',uid,x,y:100,w:80,h:60,size:2,
  color:'#1f2937',strokeOn:true,fill:true,fillColor:'#ffd166',group:'g1',groupRotation:0});
const groupOf3 = () => [groupMember('m1',100),groupMember('m2',300),groupMember('m3',500)];

test('double-clicking a grouped rect enters group edit mode; moving it leaves siblings untouched; clicking outside the group exits', async () => app(async ({page,run}) => {
  await run(`items=${JSON.stringify(groupOf3())};setTool('select');render();`);
  const canvas=await page.locator('#canvas').boundingBox();
  await page.mouse.dblclick(canvas.x+140,canvas.y+130);   // center of m1
  assert.equal(await run('editingGroupId'),'g1');
  assert.deepEqual(await run('selection'),[0]);

  await page.mouse.move(canvas.x+140,canvas.y+130);await page.mouse.down();
  await page.mouse.move(canvas.x+170,canvas.y+110);await page.mouse.up();
  const [m1,m2,m3]=await run('items');
  assert.ok(Math.abs(m1.x-130)<.5 && Math.abs(m1.y-80)<.5,'m1 moved by the drag delta (30,-20)');
  assert.equal(m2.x,300,'m2 untouched');
  assert.equal(m3.x,500,'m3 untouched');
  assert.equal(m1.group,'g1');assert.equal(m2.group,'g1');assert.equal(m3.group,'g1');

  await page.mouse.click(canvas.x+900,canvas.y+700);   // genuinely outside the group's own box
  assert.equal(await run('editingGroupId'),null);
  assert.deepEqual(await run('selection'),[]);
}));

test('undo/redo across a move performed in group edit mode', async () => app(async ({page,run}) => {
  await run(`items=${JSON.stringify(groupOf3())};setTool('select');render();`);
  const canvas=await page.locator('#canvas').boundingBox();
  await page.mouse.dblclick(canvas.x+140,canvas.y+130);
  await page.mouse.move(canvas.x+140,canvas.y+130);await page.mouse.down();
  await page.mouse.move(canvas.x+180,canvas.y+130);await page.mouse.up();
  assert.ok(Math.abs((await run('items[0].x'))-140)<.5);

  await run('undo()');
  assert.equal(await run('items[0].x'),100,'position reverts');
  assert.equal(await run('editingGroupId'),null,'undo leaves group edit mode (cancelGesture resets it)');

  await run('redo()');
  assert.ok(Math.abs((await run('items[0].x'))-140)<.5,'move re-applies on redo');
}));

// A 90° rotation swings each member's on-screen position by roughly its own distance from the group's
// pivot, so these sit closer together and lower on the canvas than groupOf3()'s usual spread, or the
// rotated members would land off-canvas.
const rotatedMember = (uid,x) => ({type:'rect',uid,x,y:400,w:80,h:60,size:2,color:'#1f2937',
  strokeOn:true,fill:true,fillColor:'#ffd166',group:'g1',groupRotation:Math.PI/2});
const rotatedGroup = () => [rotatedMember('m1',300),rotatedMember('m2',450),rotatedMember('m3',600)];
// on-screen centers of every item -- stored x/y are in the LOCAL (unrotated) frame, so with a group
// rotation the actual position of any point on an item is toWorld(item, localX, localY)
const screenCenters = run => run('items.map(it=>toWorld(it, it.x+it.w/2, it.y+it.h/2))');
const dist = (a,b) => Math.hypot(a.x-b.x, a.y-b.y);

// every member of the (only) group still encoded the way the fixture was: shared groupRotation, no own rotation
const encodedAsRotatedGroup = async run => {
  for(const it of await run('items')){
    assert.ok(Math.abs(it.groupRotation-Math.PI/2)<1e-9,'groupRotation kept');
    assert.ok(!it.rotation,'no own rotation left behind on a member');
  }
};

test('moving a member of a ROTATED group in edit mode follows the pointer on screen, leaves its siblings put, and keeps the group\'s own encoding', async () => app(async ({page,run}) => {
  await run(`items=${JSON.stringify(rotatedGroup())};setTool('select');render();`);
  const before=await screenCenters(run);
  const canvas=await page.locator('#canvas').boundingBox();
  await page.mouse.dblclick(canvas.x+before[0].x,canvas.y+before[0].y);
  assert.equal(await run('editingGroupId'),'g1');
  assert.deepEqual(await run('selection'),[0]);
  await encodedAsRotatedGroup(run);   // entering changes nothing about the data
  const rp=await run('resizePivotFor([0])');
  assert.ok(rp && Math.abs(rp.rotation-Math.PI/2)<1e-9 && dist({x:rp.cx,y:rp.cy},before[0])<.5,'the browsed member gets resize handles in its on-screen frame');
  const piv=await run('rotationPivotFor([0])');
  assert.ok(piv && Math.abs(piv.rotation-Math.PI/2)<1e-9,'and a rotation handle');

  await page.mouse.move(canvas.x+before[0].x,canvas.y+before[0].y);await page.mouse.down();
  await page.mouse.move(canvas.x+before[0].x+40,canvas.y+before[0].y);await page.mouse.up();   // 40px purely rightward on screen
  const moved=await screenCenters(run);
  assert.ok(dist(moved[0],{x:before[0].x+40,y:before[0].y})<.5,'m1 followed the pointer on screen');
  for(const i of [1,2]) assert.ok(dist(moved[i],before[i])<.5,`m${i+1} did not move`);
  await encodedAsRotatedGroup(run);   // the rotation was only folded into the members for the drag itself

  await page.mouse.click(canvas.x+before[1].x,canvas.y+before[1].y);   // pick m2
  assert.deepEqual(await run('selection'),[1]);
  await page.keyboard.press('Delete');
  const survivors=await screenCenters(run);
  assert.equal(survivors.length,2);
  assert.ok(dist(survivors[0],moved[0])<.5 && dist(survivors[1],before[2])<.5,'the survivors stay put after a sibling is deleted');
  assert.equal(await run('editingGroupId'),'g1');
  await encodedAsRotatedGroup(run);

  await run('undo()');   // the delete
  await run('undo()');   // the move
  const undone=await screenCenters(run);
  assert.equal(undone.length,3);
  for(let i=0;i<3;i++) assert.ok(dist(undone[i],before[i])<.5,`m${i+1} back where it started`);
  await encodedAsRotatedGroup(run);   // history only ever holds the group's own encoding
}));

test('deleting some members of a ROTATED group leaves the survivors in place, down to the auto-ungrouped last one', async () => app(async ({page,run}) => {
  await run(`items=${JSON.stringify(rotatedGroup())};setTool('select');render();`);
  const before=await screenCenters(run);
  await run('selection=[1];deleteSelected();');   // a partial selection, straight from the rotated state
  const two=await screenCenters(run);
  assert.equal(two.length,2);
  assert.ok(dist(two[0],before[0])<.5 && dist(two[1],before[2])<.5,'both survivors still drawn where they were');
  await encodedAsRotatedGroup(run);
  await run('selection=[1];deleteSelected();');
  const [lone]=await screenCenters(run);
  assert.ok(dist(lone,before[0])<.5,'the auto-ungrouped last survivor too');
  const it=await run('items[0]');
  assert.equal(it.group,undefined);assert.equal(it.groupRotation,undefined);
  assert.ok(Math.abs(it.rotation-Math.PI/2)<1e-9,'it keeps the look it had inside the group');
}));

// ---------- text/table: grouped instances get a TWO-STAGE double-click ----------
// Unlike rect/ellipse/etc, these two types already have their own dblclick behavior (open the text
// editor, open a cell editor) that fires unconditionally today, group or not. A grouped instance's
// FIRST double-click now only enters group edit mode instead (so it can be moved/resized/recolored/
// deleted on its own, like any other grouped shape) -- otherwise a grouped text/table item would have
// no way to be repositioned without ungrouping at all, since a plain click always grabs the whole
// group. A SECOND double-click, while already browsing THIS item's own group, opens its own editor,
// same as an ungrouped instance always could.
//
// Test note: selecting a text/table item shows its Font/Size toolbar controls, which can grow the
// toolbar and shift the canvas element's on-page position -- each of these tests re-fetches the canvas's
// boundingBox() between separate mouse gestures rather than reusing one cached box throughout, or a
// second dblclick's coordinates would silently miss the (now-shifted) target.
const groupedText = () => [
  {type:'text',uid:'t1',x:100,y:100,w:200,h:50,text:'hello',font:'400 28px sans-serif',
    color:'#1f2937',textColor:'#1f2937',strokeOn:false,fill:false,align:'center',size:2,group:'g1',groupRotation:0},
  {type:'rect',uid:'r1',x:400,y:100,w:80,h:60,size:2,color:'#1f2937',strokeOn:true,fill:true,fillColor:'#ffd166',group:'g1',groupRotation:0}
];

test('grouped text: first double-click enters group edit mode (movable), second opens the text editor', async () => app(async ({page,run}) => {
  await run(`items=${JSON.stringify(groupedText())};setTool('select');render();`);
  let canvas=await page.locator('#canvas').boundingBox();
  await page.mouse.dblclick(canvas.x+200,canvas.y+125);
  assert.deepEqual(await run('JSON.stringify({editingGroupId,selection,editingTextIdx})'),
    JSON.stringify({editingGroupId:'g1',selection:[0],editingTextIdx:null}),
    'first dblclick enters group edit mode, does not open the editor');

  // confirm it's genuinely movable now (the whole point of entering this mode first) -- re-fetch:
  // entering group edit mode just selected a text item, which can grow the toolbar (font controls)
  // and shift the canvas element, so the box cached before dblclick1 may already be stale.
  canvas=await page.locator('#canvas').boundingBox();
  await page.mouse.move(canvas.x+200,canvas.y+125);await page.mouse.down();
  await page.mouse.move(canvas.x+230,canvas.y+125);await page.mouse.up();
  const [movedText,rect]=await run('items');
  assert.ok(Math.abs(movedText.x-130)<.5,'text moved on its own');
  assert.equal(rect.x,400,'sibling rect untouched');

  canvas=await page.locator('#canvas').boundingBox();
  await page.mouse.dblclick(canvas.x+230,canvas.y+125);
  assert.equal(await run('editingTextIdx'),0,'second dblclick on the now-isolated member opens the text editor');
}));

test('grouped table: first double-click enters group edit mode, second opens the cell editor', async () => app(async ({page,run}) => {
  await run(`items=[
    {type:'table',uid:'tb1',x:100,y:100,w:200,h:80,rows:1,cols:1,size:2,color:'#000000',fontFamily:'sans',fontSize:20,
      texts:[['cell']],group:'g1',groupRotation:0},
    {type:'rect',uid:'r1',x:400,y:100,w:80,h:60,size:2,color:'#1f2937',strokeOn:true,fill:true,fillColor:'#ffd166',group:'g1',groupRotation:0}
  ];setTool('select');render();`);
  let canvas=await page.locator('#canvas').boundingBox();
  await page.mouse.dblclick(canvas.x+200,canvas.y+140);
  assert.deepEqual(await run('JSON.stringify({editingGroupId,selection,editingTextIdx})'),
    JSON.stringify({editingGroupId:'g1',selection:[0],editingTextIdx:null}),
    'first dblclick enters group edit mode, does not open the cell editor');

  canvas=await page.locator('#canvas').boundingBox();
  await page.mouse.dblclick(canvas.x+200,canvas.y+140);
  assert.equal(await run('editingTextIdx'),0,'second dblclick opens the cell editor');
  assert.deepEqual(await run('editingCell'),{r:0,c:0});
}));

// A double-click is two selection clicks before its own event arrives. Smart controls must keep
// the item grabbed by the first press, while separate clicks still reach the layers behind it.
const overlappingSmart = uid => ({type:'smart',uid,x:100,y:100,w:180,h:140,
  color:'#1f2937',fillColor:'#ffd166',fill:false,strokeOn:true,textColor:'#000',size:2,state:{},
  script:`({children(state,style,w,h){return[{type:'rect',x:0,y:0,w,h,color:style.color,strokeOn:true,fill:false}];}})`});
async function seedOverlap(run, scene){
  await run(`cancelGesture();items=${JSON.stringify(scene)};selection=[];setTool('select');render();`);
}
test('overlapping smart controls open on a fresh or already-selected double-click', async () => app(async ({page,run}) => {
  const scene=[rectangle('bottom'),rectangle('middle'),overlappingSmart('smart')];
  for(const selected of [false,true]){
    await seedOverlap(run,scene);
    let box=await page.locator('#canvas').boundingBox();
    if(selected) await page.mouse.click(box.x+190,box.y+160);
    box=await page.locator('#canvas').boundingBox();
    await page.mouse.dblclick(box.x+190,box.y+160);
    await page.waitForFunction(()=>__test.run('editingSmartIdx')===2);
    assert.deepEqual(await run('selectedUids()'),['smart']);
    assert.equal(await run('pointEditIdx'),null,'the background is not converted or edited');
    assert.deepEqual(await run('items'),scene,'entering controls leaves all drawing data unchanged');
  }
}));

test('overlapping smart controls keep the first touch target on double-tap', async () => app(async ({page,run}) => {
  const scene=[rectangle('bottom'),rectangle('middle'),overlappingSmart('smart')];
  for(const selected of [false,true]){
    await seedOverlap(run,scene);
    let box=await page.locator('#canvas').boundingBox();
    if(selected){
      await page.touchscreen.tap(box.x+190,box.y+160);
      await page.waitForTimeout(400);
    }
    box=await page.locator('#canvas').boundingBox();
    await page.touchscreen.tap(box.x+190,box.y+160);
    await page.touchscreen.tap(box.x+198,box.y+166);
    await page.waitForFunction(()=>__test.run('editingSmartIdx')===2);
    assert.deepEqual(await run('selectedUids()'),['smart']);
    assert.equal(await run('pointEditIdx'),null);
    assert.deepEqual(await run('items'),scene);
  }
}, {context:{viewport:{width:768,height:1024},hasTouch:true,isMobile:true}}));

test('ungrouped text/table still open their own editor on the very first double-click, unaffected', async () => app(async ({page,run}) => {
  await run(`items=[{type:'text',uid:'t1',x:100,y:100,w:200,h:50,text:'hello',font:'400 28px sans-serif',
    color:'#1f2937',textColor:'#1f2937',strokeOn:false,fill:false,align:'center',size:2}];setTool('select');render();`);
  const canvas=await page.locator('#canvas').boundingBox();
  await page.mouse.dblclick(canvas.x+200,canvas.y+125);
  assert.deepEqual(await run('JSON.stringify({editingGroupId,editingTextIdx})'),
    JSON.stringify({editingGroupId:null,editingTextIdx:0}));
}));

// ---------- a real double-click on a smart object's own handle must not exit edit mode ----------
// Real bug, reported directly: a real double-click on one of a smart shape's own handles (e.g. the
// Chart template's "+" add-bar button, a kind:'click' handle) left edit mode entirely -- each half of
// the double-click correctly resolved the handle's own action via onDown/onUp's smartDrag machinery,
// but the native dblclick event ALSO fired the generic "re-double-click a smart object exits edit
// mode" toggle on top of it, since onUp's smartDrag resolution was missing the handledPointerUp flag
// its sibling gestures (editingAnchor/endDrag, used by Point-Edit) already set. General fix -- any
// smart shape with its own handles benefits, not just one script -- verified here against the Chart
// template this PR itself ships.

// ---------- Smart Shape sandbox: the actual security boundary ----------
// A smart shape's script is untrusted (SMART_SHAPES.md) and runs inside a dedicated Worker with every
// network global deleted before it ever runs -- not in the app's own scope. These two tests are the
// ones that actually prove the isolation holds, rather than just that the feature still works.
test('a hostile script cannot reach the host page\'s DOM, localStorage, network, or top frame', async () => app(async ({page,run}) => {
  // The script reports what it could/couldn't reach via its own returned descriptor (child text) --
  // run() itself can't see into the worker directly, so the proof has to come back this way.
  const hostileScript = `({
    children(state, style, w, h){
      const report = {};
      try { report.parentDoc = !!window.parent.document.title; } catch(e) { report.parentDoc = 'blocked:'+e.constructor.name; }
      try { localStorage.setItem('pwned','1'); report.localStorage = 'REACHED'; } catch(e) { report.localStorage = 'blocked:'+e.constructor.name; }
      try { report.fetch = typeof fetch; } catch(e) { report.fetch = 'blocked'; }
      try { report.xhr = typeof XMLHttpRequest; } catch(e) { report.xhr = 'blocked'; }
      try { report.topLocation = window.top.location.href; } catch(e) { report.topLocation = 'blocked:'+e.constructor.name; }
      return [{type:'text', text:JSON.stringify(report), x:0,y:0,w:w,h:h, align:'left', font:'12px sans', color:'#000'}];
    }
  })`;
  await run(`items=[{type:'smart',uid:'h1',x:40,y:40,w:200,h:100,color:'#000',fillColor:'#fff',
    fill:false,strokeOn:false,textColor:'#000',size:2,fontFamily:'sans',fontSize:12,font:fontStr('sans',12),
    script:${JSON.stringify(hostileScript)},state:{}}];setTool('select');render();`);
  await page.waitForTimeout(100);   // let the cache's background children() request resolve
  const kids = await run(`smartChildrenCache.get('h1').kids`);
  const report = JSON.parse(kids[0].text);
  assert.match(report.parentDoc, /^blocked:/, 'cannot reach the host page\'s DOM through window.parent');
  assert.match(report.localStorage, /^blocked:/, 'cannot read or write the host page\'s localStorage');
  assert.equal(report.fetch, 'undefined', 'fetch is deleted inside the sandbox');
  assert.equal(report.xhr, 'undefined', 'XMLHttpRequest is deleted inside the sandbox');
  assert.match(report.topLocation, /^blocked:/, 'cannot reach the top frame either');
  // and, most directly: the host's OWN localStorage was never actually touched
  assert.equal(await run(`localStorage.getItem('pwned')`), null, 'the host page\'s real localStorage is untouched');
}));

test('an infinite loop in a script times out, recovers, and does not take down other smart shapes', async () => app(async ({page,run,context}) => {
  // Keep the offender present: recovery must preserve healthy queued work without manual renders.
  const hangScript = `({ children(){ while(true){} } })`;
  const okScript = `({ children(state,style,w,h){ return [{type:'rect',x:0,y:0,w:w,h:h,color:style.color,strokeOn:true,fill:false}]; } } )`;
  await run(`items=[
    {type:'smart',uid:'hang1',x:40,y:40,w:100,h:100,color:'#000',fillColor:'#fff',fill:false,strokeOn:false,
      textColor:'#000',size:2,fontFamily:'sans',fontSize:12,font:fontStr('sans',12),script:${JSON.stringify(hangScript)},state:{}},
    {type:'smart',uid:'ok1',x:200,y:40,w:100,h:100,color:'#000',fillColor:'#fff',fill:false,strokeOn:false,
      textColor:'#000',size:2,fontFamily:'sans',fontSize:12,font:fontStr('sans',12),script:${JSON.stringify(okScript)},state:{}}
  ];setTool('select');render();`);
  await page.waitForFunction(()=>__test.run("smartBackoffUntil.has('hang1') && smartChildrenCache.has('ok1')"));
  assert.equal(await run(`smartChildrenCache.has('hang1')`), false, 'the hung shape never got a result, but caused no crash');
  const fresh = await run(`requestSmartCall('({children(){return [{type:"rect",x:1,y:2,w:3,h:4}]}})', 'children', [{},{},10,10,false])`);
  assert.deepEqual(fresh, [{type:'rect',x:1,y:2,w:3,h:4}], 'a different owner still executes');
  const okKids = await run(`smartChildrenCache.get('ok1') && smartChildrenCache.get('ok1').kids`);
  assert.ok(okKids && okKids.length, 'the healthy shape renders while the offender remains');
  assert.equal(await run('items.length'),2);
  await run('selection=[1];render()');await page.keyboard.press('ArrowRight');
  assert.equal(await run('items[1].x'),201);await run('undo()');assert.equal(await run('items[1].x'),200);
  const svg=await run('itemsToSVGMarkup(items,{width:600,height:300,background:false})');
  const preview=await context.newPage();await preview.setContent(svg);
  const position=await preview.locator('rect').evaluate(rect=>{
    const p=new DOMPoint(rect.x.baseVal.value,rect.y.baseVal.value).matrixTransform(rect.getCTM());
    return {x:p.x,y:p.y};
  });
  assert.deepEqual(position,{x:200,y:40},'healthy content still exports at its world position beside a hanging owner');
}));

// Real bug, reported directly: a smart shape's polygon-type children (a flag pennant, a clock's own
// elapsed-time wedge, an arrow's curved shaft -- anything with a `points` array) drifted further off
// its container on every single repaint, winding up well outside the container within a few frames.
// Cached geometry must stay local and unchanged across paints, including nested curve controls.

// Real bug, reported directly: a smart shape built from a long reference template (race-start-timer.js,
// ~37,300 characters with its full explanatory header comment -- SMART_SHAPES.md explicitly tells
// readers to paste a reference script's whole file that way) was silently rejected as "invalid" the
// moment it went through a save/load round-trip (export the Shape Library, re-import it into a fresh
// view) -- creating it live via the dialog never checks script length at all, so the problem only
// surfaced later. Root cause: normalizeItem's own MAX_SCRIPT cap (20,000, set before any example this
// long existed) was well under half of what the documented workflow actually produces. Fixed by
// raising the cap to 50,000.
test('a smart shape with a long reference-template script survives a save/load round-trip', async () => app(async ({page,run}) => {
  const result = await run(`
    (() => {
      // Pad a trivial script with a long comment, well past the OLD 20,000-char cap but under the
      // new 50,000 one -- mirrors race-start-timer.js's own shape (mostly explanatory comment).
      const padding = '/*' + 'x'.repeat(30000) + '*/';
      const script = padding + '\\n({ children(state,style,w,h){ return [{type:"rect",x:0,y:0,w:w,h:h,color:style.color,strokeOn:true,fill:false}]; } })';
      const raw = {type:'smart',uid:'long1',x:10,y:10,w:100,h:100,color:'#000',fillColor:'#fff',
        fill:false,strokeOn:true,textColor:'#000',size:2,fontFamily:'sans',fontSize:12,
        font:fontStr('sans',12),script,state:{}};
      const scene = normalizeScene([raw], {}, FORMAT_VERSION);
      return JSON.stringify({ scriptLength: script.length, itemCount: scene.items.length,
        survived: scene.items.length===1 && scene.items[0].type==='smart' });
    })()
  `);
  const parsed = JSON.parse(result);
  assert.ok(parsed.scriptLength > 20000, 'the test script must actually exceed the OLD cap to be meaningful');
  assert.ok(parsed.survived, `a ${parsed.scriptLength}-character script must survive normalizeScene (a real save/load round-trip), not be silently dropped`);
}));

// ---------- Iconify icon import ----------
const SAILBOAT = '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M22 18H2a4 4 0 0 0 4 4h12a4 4 0 0 0 4-4Z"/><path d="M21 14 10 2 3 14h18Z"/><path d="M10 2v16"/></g>';

async function routeIconify(page){
  const cors = {'access-control-allow-origin':'*'};
  await page.route('https://api.iconify.design/**', route => {
    const url = new URL(route.request().url());
    if(url.pathname==='/search') return route.fulfill({headers:cors, contentType:'application/json', body:JSON.stringify({
      icons:['gplset:sailboat','lucide:sailboat','multi:sailboat'], total:3, limit:96, start:0,
      collections:{
        lucide:{name:'Lucide', author:{name:'Lucide Contributors', url:'https://github.com/lucide-icons/lucide'},
          license:{title:'ISC', spdx:'ISC', url:'https://github.com/lucide-icons/lucide/blob/main/LICENSE'}, tags:['Uses Stroke'], palette:false},
        gplset:{name:'GPL Icons', author:{name:'Someone'}, license:{title:'GPL 3.0', spdx:'GPL-3.0', url:'javascript:alert(1)'}, palette:false},
        multi:{name:'Colorful', license:{title:'MIT', spdx:'MIT'}, palette:true},
      }})});
    if(url.pathname==='/multi.json') return route.fulfill({headers:cors,contentType:'application/json',body:JSON.stringify({width:24,height:24,icons:{sailboat:{body:'<rect width="12" height="24" fill="red"/><rect x="12" width="12" height="24" fill="blue"/>'}}})});
    if(url.pathname==='/lucide.json') return route.fulfill({headers:cors, contentType:'application/json',
      body:JSON.stringify({prefix:'lucide', width:24, height:24, icons:{sailboat:{body:SAILBOAT}}})});
    if(url.pathname.endsWith('.svg')) return route.fulfill({headers:cors, contentType:'image/svg+xml',
      body:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"/>'});
    return route.fulfill({status:404, headers:cors, body:''});
  });
}

test('icon dialog filters licenses, imports an icon with its license, and places it as one group', async () => app(async ({page,run}) => {
  await routeIconify(page);
  const iconRequests = [];
  page.on('request', r => { if(r.url().startsWith('https://api.iconify.design/')) iconRequests.push(new URL(r.url()).pathname); });
  await run('openIconDialog()');
  await page.fill('#iconSearchInput', 'sailboat');
  await page.click('#iconSearchBtn');
  await page.waitForSelector('#iconResults .shape-entry');
  assert.equal(await page.locator('#iconResults .shape-entry').count(), 2, 'GPL hidden, multicolor included');
  assert.match(await page.textContent('#iconStatus'), /1 hidden by the license filter/);
  await page.uncheck('#iconPermissiveOnly');
  await page.waitForFunction(()=>document.querySelectorAll('#iconResults .shape-entry').length===3);
  assert.equal(await page.locator('#iconResults .icon-license.restricted').count(), 1);
  assert.equal(await page.locator('#iconResults [href^="javascript"]').count(), 0, 'non-http license links are not linked');
  await page.check('#iconPermissiveOnly');
  await page.waitForFunction(()=>document.querySelectorAll('#iconResults .shape-entry').length===2);
  assert.match(await page.locator('#iconResults .icon-license').first().textContent(), /Lucide/);
  await page.locator('#iconResults .shape-thumb').first().click();
  await page.waitForFunction(()=>__test.run('shapeLibrary && shapeLibrary.shapes.length')===1);
  const lib = JSON.parse(await run(`JSON.stringify({open: iconDialog.open, entry: shapeLibrary.shapes[0],
    roundTrip: normalizeShapeLibrary(JSON.parse(JSON.stringify(shapeLibrary))).shapes[0].source})`));
  assert.equal(lib.open, false, 'dialog closes after import');
  assert.equal(lib.entry.name, 'sailboat');
  assert.equal(lib.entry.source.license.spdx, 'ISC');
  assert.equal(lib.entry.source.setName, 'Lucide');
  assert.deepEqual(lib.roundTrip, lib.entry.source, 'source survives export/import normalization');
  assert.equal(lib.entry.items.length, 3);
  await run('openIconDialog()');
  await page.locator('#iconResults .shape-thumb').first().click();
  await page.waitForFunction(()=>__test.run('shapeLibrary.shapes.length')===2);
  assert.equal(await run('shapeLibrary.shapes[1].name'), 'sailboat 2', 'a second import gets a unique name');
  assert.ok(!iconRequests.some(p=>p.endsWith('.svg')), 'thumbnails are drawn from batched set data, not one request per icon');
  assert.equal(iconRequests.filter(p=>p==='/lucide.json').length, 1, 'one request per set, reused for both imports');
  assert.match(await page.locator('#iconResults img').first().getAttribute('src'), /^data:image\/svg\+xml,/);
  const placed = JSON.parse(await run(`(async()=>{ await placeShapeAt(shapeLibrary.shapes[0], 400, 300);
    return JSON.stringify(items.map(i=>({type:i.type, group:i.group}))); })()`));
  assert.equal(placed.length, 3);
  assert.ok(placed[0].group!=null && placed.every(i=>i.group===placed[0].group), 'placed icon is one group');
}));

const smartFixture = (script, state={}) => ({type:'smart',uid:'smart-test',x:100,y:100,w:180,h:180,
  color:'#000000',fillColor:'#dc2626',strokeOn:true,fill:false,textColor:'#000000',size:2,
  fontFamily:'sans',fontSize:12,font:'600 12px sans-serif',script,state});
async function importLibrary(page, library){
  await page.locator('#shapeLibraryInput').setInputFiles({name:'library.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(library))});
}
const slowClickScript = `({
  children(){return [{type:'rect',x:0,y:0,w:180,h:180}];},
  handles(){return [{id:'inc',x:50,y:50,kind:'click'}];},
  hitEdit(s,x,y){const end=performance.now()+40;while(performance.now()<end){}return Math.hypot(x-50,y-50)<14?'inc':null;},
  dragEdit(s){const end=performance.now()+40;while(performance.now()<end){}return {n:(s.n||0)+1};}
})`;

async function openExport(page,run,context,{init}={}){
  const download=page.waitForEvent('download');await run('exportHtml()');
  const file=await(await download).path(),directory=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'simplecanvas-html-'));
  const htmlFile=path.join(directory,'sketch.html');fs.copyFileSync(file,htmlFile);
  context.on('close',()=>fs.rmSync(directory,{recursive:true,force:true}));
  const preview=await context.newPage(),errors=[],requests=[];
  preview.on('pageerror',error=>errors.push(error.message));
  preview.on('request',request=>{if(/^https?:/.test(request.url()))requests.push(request.url());});
  if(init)await preview.addInitScript(init);
  await preview.goto(require('node:url').pathToFileURL(htmlFile).href);
  return {preview,errors,requests,source:fs.readFileSync(file,'utf8')};
}
async function exportedPoint(host,x,y,parent=false){
  return host.evaluate((el,{x,y,parent})=>{
    const p=new DOMPoint(x,y).matrixTransform((parent?el:el.firstElementChild).getScreenCTM());
    return {x:p.x,y:p.y};
  },{x,y,parent});
}
// Native pointer injection can quantize screen coordinates. Keep real browser gestures, but
// assert geometry against the events the app received using matrices captured before the drag.
async function recordExportGesture(host,gesture){
  await host.evaluate(el=>{
    const matrix=el.firstElementChild.getScreenCTM(),inverse=matrix.inverse();
    const state={down:null,latest:null,up:null};
    const record=event=>{
      const point=new DOMPoint(event.clientX,event.clientY).matrixTransform(inverse);
      const sample={screen:{x:event.clientX,y:event.clientY},local:{x:point.x,y:point.y}};
      if(event.type==='pointerdown'){state.down=sample;state.latest=null;}
      else if(state.down)state[event.type==='pointermove'?'latest':'up']=sample;
    };
    const types=['pointerdown','pointermove','pointerup'];
    for(const type of types)window.addEventListener(type,record,true);
    el.__testGesture={state,stop:()=>{for(const type of types)window.removeEventListener(type,record,true);}};
  });
  try{
    await gesture();
    const result=await host.evaluate(el=>el.__testGesture.state);
    assert.ok(result.down,'the gesture must deliver a pointerdown');
    const end=result.up||result.latest||result.down;
    return {...result,end,screenDelta:{x:end.screen.x-result.down.screen.x,y:end.screen.y-result.down.screen.y},
      localDelta:{x:end.local.x-result.down.local.x,y:end.local.y-result.down.local.y}};
  }finally{await host.evaluate(el=>{el.__testGesture.stop();delete el.__testGesture;});}
}

async function exportClick(preview,host,x,y){const p=await exportedPoint(host,x,y);await preview.mouse.click(p.x,p.y);}
async function exportDrag(preview,host,x,y,dx,dy,release=true){
  const a=await exportedPoint(host,x,y),b=await exportedPoint(host,x+dx,y+dy);
  const gesture=await recordExportGesture(host,async()=>{
    await preview.mouse.move(a.x,a.y);await preview.mouse.down();
    await preview.mouse.move(b.x,b.y,{steps:5});if(release)await preview.mouse.up();
  });
  assert.ok(gesture.latest,'drag must deliver a pointermove');
  if(release)assert.ok(gesture.up,'released drag must deliver a pointerup');
  assert.ok(Math.abs(gesture.end.screen.x-b.x)<=1 && Math.abs(gesture.end.screen.y-b.y)<=1,'drag reaches the requested screen endpoint within one CSS pixel');
  return gesture;
}

test('HTML smart shapes run offline with live timing, direct ordered controls and a locked layout',async()=>app(async({page,run,context})=>{
  // Keep this refresh-only/API1 fixture inert in saved state. API2 Live Clock
  // deliberately publishes durable time and pulses and has its own connection tests.
  const clockScript=`({refreshMs(){return 1000;},children(s,style,w,h){return [{type:'text',x:0,y:0,w,h,text:new Date().toISOString(),strokeOn:false}];}})`;
  const stopwatch=await run(`(async()=>{
    const sw={...${JSON.stringify(smartFixture(''))},script:SMART_TEMPLATES.stopwatch.script};await initializeSmartItem(sw);
    items=[sw,{...${JSON.stringify(smartFixture(clockScript))},uid:'refresh-clock',x:500,h:208}];
    setTool('select');selection=[];render();save();return sw;
  })()`);
  await savedWorkspace(run);
  const before=await run('(async()=>JSON.stringify({items,undoStack,redoStack,storage:await readSavedWorkspace()}))()');
  const {preview,errors,requests}=await openExport(page,run,context,{init:()=>{
    // Force early callbacks, as can occur naturally when browsers round fractional delays.
    const timeout=window.setTimeout.bind(window);
    window.setTimeout=(fn,delay,...args)=>timeout(fn,delay>10?delay-2:delay,...args);
  }});
  const sw=preview.locator('[data-smart-index="0"]'),clock=preview.locator('[data-smart-index="1"]');
  await preview.waitForFunction(()=>document.querySelectorAll('[data-smart-ready="true"]').length===2);
  assert.match(await sw.textContent(),/Start.*Reset/,'operating buttons are visible immediately');
  const firstClock=await clock.textContent();
  await preview.waitForFunction(first=>document.querySelector('[data-smart-index="1"]').textContent!==first,firstClock);
  await exportClick(preview,sw,stopwatch.w/4,stopwatch.h*.86);
  await preview.waitForFunction(()=>document.querySelector('[data-smart-index="0"]').textContent.includes('Pause'));
  await preview.waitForFunction(()=>!document.querySelector('[data-smart-index="0"]').textContent.includes('00:00:00.000'));
  await exportClick(preview,sw,stopwatch.w/4,stopwatch.h*.86);
  await preview.waitForFunction(()=>document.querySelector('[data-smart-index="0"]').textContent.includes('Start'));
  const paused=await sw.textContent();await preview.waitForTimeout(250);assert.equal(await sw.textContent(),paused);
  // Quick released clicks still execute in order. Reset, Start, Pause must end stopped.
  await exportClick(preview,sw,stopwatch.w*.75,stopwatch.h*.86);
  await exportClick(preview,sw,stopwatch.w/4,stopwatch.h*.86);await exportClick(preview,sw,stopwatch.w/4,stopwatch.h*.86);
  await preview.waitForFunction(()=>document.querySelector('[data-smart-index="0"]').textContent.includes('Start'));
  const box=await sw.boundingBox();await exportDrag(preview,sw,20,20,60,40);await preview.waitForTimeout(100);
  assert.deepEqual(await sw.boundingBox(),box,'the body cannot be moved');
  assert.equal(await sw.locator('[data-resize-width]').count(),0,'no regular resize controls');
  assert.equal(await sw.locator('[data-resize-height],[data-rotate]').count(),0,'rotation and height resizing also default off');
  assert.equal(await run('(async()=>JSON.stringify({items,undoStack,redoStack,storage:await readSavedWorkspace()}))()'),before,'export interactions never edit the source workspace');
  assert.deepEqual(requests,[],'the downloaded file needs no server or network');assert.deepEqual(errors,[]);
}));

test('HTML uses static script permissions, filters editor-only controls and handles, and retains tab instance state',async()=>app(async({page,run,context})=>{
  const script=`({exportBehavior:{move:true,resizeWidth:false},
    children(s,style,w,h){return [{type:'rect',x:0,y:0,w,h,fill:true,fillColor:'#ffd166'},
      {type:'text',x:0,y:0,w,h:30,text:String(s.n||0),strokeOn:false},
      {type:'text',x:0,y:50,w,h:30,text:'AUTHOR ONLY',editorOnly:true}];},
    handles(){return [{id:'inc',x:40,y:20,kind:'click'},{id:'author',x:40,y:65,kind:'click',editorOnly:true}];},
    hitEdit(s,x,y){return y<40?'inc':y<90?'author':null;},
    dragEdit(s,id){return {n:(s.n||0)+(id==='inc'?1:100)};}})`;
  await run(`items=[${JSON.stringify(smartFixture(script))}];save();newTab();items=[${JSON.stringify(smartFixture(script,{n:9}))}];render();save();`);
  const snapshot=await run('itemsToSVGMarkup(items)');assert.doesNotMatch(snapshot,/AUTHOR ONLY/,'even unconditional author children stay out of static exports');
  const {preview,errors}=await openExport(page,run,context);
  const panels=preview.locator('.tab-panel'),first=panels.nth(0).locator('[data-smart-index]'),second=panels.nth(1).locator('[data-smart-index]');
  await preview.waitForFunction(()=>document.querySelector('.tab-panel [data-smart-ready="true"]'));
  assert.equal(await first.locator('[data-rotate]').count(),0,'move permission alone does not implicitly grant rotation');
  assert.equal(await first.textContent(),'0');await exportClick(preview,first,40,20);
  await preview.waitForFunction(()=>document.querySelector('.tab-panel [data-smart-index]').textContent==='1');
  await exportClick(preview,first,40,65);await preview.waitForTimeout(100);assert.equal(await first.textContent(),'1','author-only handles never run');
  const start=await exportedPoint(first,0,0),end=await exportedPoint(first,30,25);
  await exportDrag(preview,first,60,110,30,25);await preview.waitForTimeout(100);
  const moved=await exportedPoint(first,0,0);assert.ok(Math.abs(moved.x-end.x)<.1 && Math.abs(moved.y-end.y)<.1);assert.notEqual(start.x,moved.x);
  await preview.locator('.tab-select').nth(1).click();
  await preview.waitForFunction(()=>document.querySelectorAll('[data-smart-ready="true"]').length===2);
  assert.equal(await second.textContent(),'9');await exportClick(preview,second,40,20);
  await preview.waitForFunction(()=>document.querySelectorAll('.tab-panel [data-smart-index]')[1].textContent==='10');
  await preview.locator('.tab-select').nth(0).click();assert.equal(await first.textContent(),'1');assert.deepEqual(await exportedPoint(first,0,0),moved);
  assert.deepEqual(errors,[]);
}));

test('HTML isolates hostile or hung scripts, preserves frozen fallback, and escapes embedded source and state',async()=>app(async({page,run,context})=>{
  const attack="</script><script>window.exportEscaped=true</script> $& $` $'";
  const hostile=`({children(s,style,w,h){return [{type:'text',x:0,y:0,w,h,text:s.text+' '+typeof document+' '+typeof fetch,strokeOn:false}];}})`;
  const hang=`({children(s,style,w,h,editing){if(editing)while(true){}return [{type:'rect',x:0,y:0,w,h,fill:true,fillColor:'#22c55e'}];}})`;
  await run(`(async()=>{
    const clock={...${JSON.stringify(smartFixture(''))},uid:'clock',script:SMART_TEMPLATES.liveClock.script,x:700};
    await initializeSmartItem(clock);
    items=[${JSON.stringify(smartFixture(hostile,{text:attack}))},{...${JSON.stringify(smartFixture(hang))},uid:'hang',x:400},clock];render();
  })()`);
  const {preview,errors,requests}=await openExport(page,run,context);
  await preview.waitForFunction(()=>document.querySelectorAll('[data-smart-ready="true"]').length===2);
  assert.equal(await preview.evaluate(()=>window.exportEscaped),undefined);
  const text=await preview.locator('[data-smart-index="0"]').textContent();assert.equal(text.replace(/\s/g,''),(attack+' undefined undefined').replace(/\s/g,''));
  assert.equal(await preview.locator('[data-smart-index="1"] rect').getAttribute('fill'),'#22c55e','a failed live rendering retains the static drawing');
  const clock=preview.locator('[data-smart-index="2"]'),first=await clock.textContent();
  await preview.waitForFunction(first=>document.querySelector('[data-smart-index="2"]').textContent!==first,first);
  assert.deepEqual(requests,[]);assert.deepEqual(errors,[]);
}));

test('an edited preview supersedes an in-flight job even when the script changes back',async()=>app(async({page,run})=>{
  const first='({children(){return [{type:"rect",x:0,y:0,w:100,h:100,fill:true,fillColor:"#ff0000"}];}})';
  const second=first.replace('#ff0000','#00ff00');
  await run(`
    const create=createShapeThumbnail;window.previewStarted=0;window.finishOldPreview=null;
    createShapeThumbnail=list=>{
      if(window.previewStarted++===0)return new Promise(resolve=>window.finishOldPreview=resolve);
      return create(list);
    };
    shapeLibrary=normalizeShapeLibrary({shapes:[{name:'Changing',items:[${JSON.stringify(smartFixture(first))}]}]});
    smartPreviewConsent.add(shapeLibrary.shapes[0]);setShapePicker(true);
    const tpl=shapeLibrary.shapes[0];
    tpl.items[0].script=${JSON.stringify(second)};invalidateShapePreview(tpl);
    tpl.items[0].script=${JSON.stringify(first)};invalidateShapePreview(tpl);
  `);
  const exporting=downloadedJSON(page,run,'exportShapeLibrary()');
  await page.evaluate(()=>window.finishOldPreview('data:image/png;base64,STALE'));
  const library=await exporting;
  assert.equal(await page.evaluate(()=>window.previewStarted),2,'the obsolete job is discarded and a fresh preview is generated');
  assert.notEqual(library.shapes[0].thumbnail.png,'data:image/png;base64,STALE','export waits for the replacement preview');
  await page.waitForFunction(()=>document.querySelector('.shape-thumb img')?.naturalWidth===128);
  assert.equal(await page.locator('#generateShapePreviews').isVisible(),false);
}));

test('per-instance Workers contain handler replacement and prototype tampering',async()=>app(async({run})=>{
  const handler=`(self.onmessage=e=>postMessage(JSON.stringify({id:e.data.id,ok:true,result:{owned:true}})),{children(){return [];}})`;
  const prototype=`(Object.prototype.workerPoison='attacker',{children(){return [];}})`;
  const result=await run(`(async()=>{
    const victim={script:'({children(){return [];},dragEdit(s){return {value:s.value+1,clean:!({}).workerPoison};}})'};
    const results=[];
    for(const script of ${JSON.stringify([handler,prototype])}){
      await requestSmartCall({script},'children',[]);
      results.push(await requestSmartCall(victim,'dragEdit',[{value:7}]));
    }
    return results;
  })()`);
  assert.deepEqual(result,[{value:8,clean:true},{value:8,clean:true}]);
}));

test('idle malicious Workers cannot forge another owners active request with guessed IDs',async()=>app(async({run})=>{
  const attacker=`({children(){setTimeout(()=>{for(let id=1;id<50;id++)postMessage(JSON.stringify({id,owner:'instance-2',version:1,ok:true,result:{owned:true}}));},40);return [];}})`;
  const victim=`({children(){return [];},dragEdit(s){const end=performance.now()+100;while(performance.now()<end){}return {value:s.value+1};}})`;
  const result=await run(`(async()=>{
    await requestSmartCall({script:${JSON.stringify(attacker)}},'children',[]);
    return requestSmartCall({script:${JSON.stringify(victim)}},'dragEdit',[{value:7}]);
  })()`);
  assert.deepEqual(result,{value:8});
}));

test('source replacement rejects in-flight state replies and creates a fresh execution owner',async()=>app(async({page,run})=>{
  const delayed=slowClickScript.replace('performance.now()+40;while(performance.now()<end){}return {n:',
    'performance.now()+150;while(performance.now()<end){}return {n:');
  await run(`items=[${JSON.stringify(smartFixture(delayed))}];setTool('select');selection=[0];editingSmartIdx=0;undoStack=[];render();`);
  const b=await page.locator('#canvas').boundingBox();await page.mouse.click(b.x+150,b.y+150);
  await page.waitForFunction(()=>__test.run('smartSandboxPending.get(smartSandboxActive)?.message.fn')==='dragEdit');
  await run(`items[0].script=${JSON.stringify(slowClickScript)};render();`);await run('smartHitSettled');
  assert.deepEqual(await run('items[0].state'),{});assert.equal(await run('undoStack.length'),0);
  await page.mouse.click(b.x+150,b.y+150);await run('smartHitSettled');
  assert.deepEqual(await run('items[0].state'),{n:1});
}));

test('missing smart previews require consent; exported PNGs load without executing scripts', async()=>app(async({page,run})=>{
  const library={shapes:[{name:'Counter',items:[smartFixture(slowClickScript)]}]};
  await importLibrary(page,library);
  await page.locator('#libraryDialog[open]').waitFor();
  assert.match(await page.locator('#libraryDialogMessage').textContent(),/runs scripts/);
  // The print preview has no script permission; only the Worker bridge can execute scripts.
  assert.equal(await page.locator('iframe[sandbox~="allow-scripts"]').count(),0,'import alone must not start script execution');
  await page.locator('#libraryDialogCancel').click();
  assert.equal(await page.locator('.shape-thumb img').count(),0);
  await page.locator('#generateShapePreviewsBtn').click();
  await page.locator('#libraryDialogSubmit').click();
  await page.locator('.shape-thumb img').waitFor();
  const exported=await downloadedJSON(page,run,'exportShapeLibrary()');
  assert.match(exported.shapes[0].thumbnail.png,/^data:image\/png;base64,/);
  assert.equal(exported.shapes[0].thumbnail.version,1);
  await contextFresh(exported);
  async function contextFresh(data){
    await run('persistWorkspace()');await page.reload();
    await importLibrary(page,data);
    await page.locator('.shape-thumb img').waitFor();
    assert.equal(await page.locator('#libraryDialog[open]').count(),0);
    assert.equal(await page.locator('iframe[sandbox~="allow-scripts"]').count(),0,'bundled PNG must not run the smart script');
    const unchanged=await downloadedJSON(page,run,'exportShapeLibrary()');
    assert.equal(unchanged.shapes[0].thumbnail.png,data.shapes[0].thumbnail.png);
    const changed=JSON.parse(JSON.stringify(data));changed.shapes[0].items[0].state={group:2};
    await importLibrary(page,changed);
    await page.locator('#libraryDialog[open]').waitFor();
    assert.equal(await page.locator('.shape-thumb img').count(),0,'all script state participates in preview invalidation');
    assert.equal(await page.locator('iframe[sandbox~="allow-scripts"]').count(),0,'a stale PNG requires fresh consent');
    await page.locator('#libraryDialogCancel').click();
  }
}));

const demoLibrary = fs.readFileSync(path.join(__dirname,'..','examples','demo-shapes-library.json'),'utf8');
const demoShapeCount = JSON.parse(demoLibrary).shapes.length;

test('optional smart refresh redraws without changing state, history or saves, and follows document visibility and lifetime',async()=>app(async({page,run})=>{
  const script=`({refreshMs(){return 100;},children(){return [{type:'text',x:0,y:0,w:180,h:30,text:String(Date.now())}];}})`;
  await run(`items=[${JSON.stringify(smartFixture(script,{keep:'saved'}))}];setTool('select');selection=[];save();render();`);
  await page.waitForFunction(()=>__test.run("smartChildrenCache.get('smart-test')?.kids.length")===1);
  await savedWorkspace(run);
  const first=await run(`(async()=>({reading:smartChildrenCache.get('smart-test').kids[0].text,
    saved:await readSavedWorkspace(),history:undoStack.length,tab:activeTabId}))()`);
  await page.waitForFunction(first=>__test.run("smartChildrenCache.get('smart-test')?.kids[0]?.text")!==first,first.reading);
  assert.deepEqual(await run('readSavedWorkspace()'),first.saved);
  assert.deepEqual(await run('items[0].state'),{keep:'saved'});assert.equal(await run('undoStack.length'),first.history);
  await run('newTab()');
  assert.equal(await run('smartRefreshTimer'),null);assert.equal(await run('smartChildrenCache.size'),0);
  await run(`activateTab(${JSON.stringify(first.tab)})`);
  await page.waitForFunction(()=>__test.run("smartChildrenCache.get('smart-test')?.kids.length")===1);
  await run(`Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));`);
  await page.waitForFunction(()=>__test.run('smartInFlight.size')===0);
  const hidden=await run("({requests:smartSandboxReqSeq,reading:smartChildrenCache.get('smart-test').kids[0].text})");
  await page.waitForTimeout(250);
  assert.equal(await run('smartSandboxReqSeq'),hidden.requests,'hidden documents stop refreshing');
  assert.equal(await run('smartRefreshTimer'),null);
  await run(`Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));`);
  await page.waitForFunction(first=>__test.run("smartChildrenCache.get('smart-test')?.kids[0]?.text")!==first,hidden.reading);
  await run('selection=[0];deleteSelected()');
  assert.equal(await run('smartRefreshTimer'),null);assert.equal(await run('smartChildrenCache.size'),0);
}));

async function printFrameReady(page){
  await page.waitForFunction(()=>__test.run('printPreviewReady'));
}

test('printing preserves physical ruler scale, assets and pending text on the active sketch without changing the drawing',async()=>app(async({page,run})=>{
  await run(`(async()=>{items=[{...${JSON.stringify(rectangle())},fillColor:'#ef4444'}];save();newTab();
    const ruler={...${JSON.stringify(smartFixture(''))},script:SMART_TEMPLATES.ruler.script};
    await initializeSmartItem(ruler);ruler.x=100;ruler.y=100;
    const c=document.createElement('canvas');c.width=c.height=8;c.getContext('2d').fillRect(0,0,8,8);
    assets={printImage:c.toDataURL()};items=[ruler,{...${JSON.stringify(wrappedText)},x:100,y:300,text:'old'},
      {type:'image',id:'printImage',x:450,y:100,w:40,h:40}];
    setTool('select');selection=[0];editingSmartIdx=0;render();openText(1);textInput.value='Latest print note';})()`);
  await page.locator('#menuBtn').click();await page.locator('[data-act="print"]').click();
  await page.locator('#printDialog[open]').waitFor();await printFrameReady(page);
  assert.equal(await page.locator('#printMode').inputValue(),'actual');
  assert.equal(await page.locator('#printOrientation').inputValue(),'landscape');
  assert.equal(await run('items[1].text'),'Latest print note');
  await savedWorkspace(run);
  const before=await run('(async()=>({scene:JSON.stringify(items),history:undoStack.length,assets:JSON.stringify(assets),saved:await readSavedWorkspace()}))()');
  await page.locator('#printReference').check();await printFrameReady(page);
  const result=await page.locator('#printPreview').evaluate(frame=>{
    const doc=frame.contentDocument,page=doc.querySelector('body>svg'),art=doc.querySelector('.print-artwork>svg');
    return {paper:[page.getAttribute('width'),page.getAttribute('height')],ratio:+art.getAttribute('width')/+art.getAttribute('viewBox').split(/\s+/)[2],
      reference:doc.querySelector('.print-calibration path').getBBox().width,
      images:doc.querySelectorAll('image').length,text:doc.body.textContent,markup:doc.querySelector('.print-artwork').innerHTML};
  });
  assert.deepEqual(result.paper,['297mm','210mm']);assert.ok(Math.abs(result.ratio-25.4/96)<1e-10);
  assert.equal(result.reference,50);assert.equal(result.images,1);assert.match(result.text,/Latest\s*print\s*note/);
  assert.ok(!result.markup.includes('#ef4444'),'background tabs are not printed');
  assert.ok(!result.text.includes('↻'),'edit-mode controls are not printed');
  await page.locator('#printPaper').selectOption('letter');await page.locator('#printOrientation').selectOption('landscape');
  await page.locator('#printMargin').fill('13');await printFrameReady(page);
  assert.deepEqual(await page.locator('#printPreview').evaluate(frame=>{
    const page=frame.contentDocument.querySelector('body>svg'),clip=frame.contentDocument.querySelector('clipPath rect');
    return [page.getAttribute('width'),page.getAttribute('height'),clip.getAttribute('x')];
  }),['279.4mm','215.9mm','13']);
  await page.locator('#printPreview').evaluate(frame=>{frame.contentWindow.print=()=>{frame.dataset.printCalls=String(+(frame.dataset.printCalls||0)+1);};});
  await page.locator('#printDialogSubmit').click();
  assert.equal(await page.locator('#printPreview').getAttribute('data-print-calls'),'1','Print targets the prepared document');
  assert.deepEqual(await run('(async()=>({scene:JSON.stringify(items),history:undoStack.length,assets:JSON.stringify(assets),saved:await readSavedWorkspace()}))()'),before);
  await page.locator('#printDialogCancel').click();await page.waitForFunction(()=>__test.run('printSnapshot')===null);
}));

test('tiled printing keeps physical scale, matching overlap marks, numbered previews, and every sheet in the PDF',async()=>app(async({page,run,context})=>{
  await run(`items=[{...${JSON.stringify(rectangle())},w:2000,h:1100}];save();render();`);
  await savedWorkspace(run);
  const before=await run('(async()=>JSON.stringify({items,undoStack,redoStack,assets,storage:await readSavedWorkspace()}))()');
  await page.keyboard.press('Control+p');await page.locator('#printDialog[open]').waitFor();
  await page.locator('#printMode').selectOption('tile');await printFrameReady(page);
  assert.equal(await page.locator('#printOverlap').inputValue(),'10');
  assert.equal(await page.locator('#printAlignment').isChecked(),true);
  assert.equal(await page.locator('#printWarning').isVisible(),false,'tiling preserves the whole drawing without a clipping override');
  assert.match(await page.locator('#printSummary').textContent(),/100%.*2 columns × 2 rows.*4 pages/);
  const sheets=await page.locator('#printPreview').evaluate(frame=>[...frame.contentDocument.querySelectorAll('body>svg')].map(sheet=>{
    const art=sheet.querySelector('.print-artwork>svg'),clip=sheet.querySelector('clipPath rect');
    const path=sheet.querySelector('.print-alignment path'),marks=[];
    for(let distance=2;distance<path.getTotalLength();distance+=8){
      const point=path.getPointAtLength(distance);marks.push([point.x-+art.getAttribute('x'),point.y-+art.getAttribute('y')]);
    }
    return {x:+art.getAttribute('x'),y:+art.getAttribute('y'),w:+art.getAttribute('width'),h:+art.getAttribute('height'),
      ratio:+art.getAttribute('width')/+art.getAttribute('viewBox').split(/\s+/)[2],
      area:[+clip.getAttribute('width'),+clip.getAttribute('height')],marks,label:sheet.querySelector('.print-page-number').textContent};
  }));
  assert.equal(sheets.length,4);
  for(const sheet of sheets){assert.ok(Math.abs(sheet.ratio-25.4/96)<1e-10);assert.deepEqual(sheet.area,[277,182]);}
  assert.equal(sheets[0].x-sheets[1].x,267,'adjacent columns repeat 10 mm');
  assert.equal(sheets[0].y-sheets[2].y,172,'adjacent rows repeat 10 mm');
  assert.deepEqual(sheets[0].marks.slice(0,2),sheets[1].marks.slice(0,2),'horizontal neighbours share registration coordinates');
  assert.deepEqual(sheets[0].marks.slice(2),sheets[2].marks.slice(2),'vertical neighbours share registration coordinates');
  assert.ok(sheets[1].x+sheets[1].w<=10+277 && sheets[3].y+sheets[3].h<=10+182,'last column and row cover the remaining drawing');
  assert.match(sheets[3].label,/Page 4 of 4.*Row 2, column 2/);
  assert.equal(await page.locator('#printPagePrev').isDisabled(),true);
  for(let i=0;i<3;i++)await page.locator('#printPageNext').click();
  assert.match(await page.locator('#printPageLabel').textContent(),/Page 4 of 4.*Row 2, column 2/);
  assert.equal(await page.locator('#printPageNext').isDisabled(),true);
  const output=await context.newPage();
  try{
    await output.setContent(await page.locator('#printPreview').evaluate(frame=>frame.contentDocument.documentElement.outerHTML));
    assert.equal(await output.locator('body>svg:visible').count(),1);
    await output.emulateMedia({media:'print'});
    assert.equal(await output.locator('body>svg:visible').count(),4,'printing includes every sheet regardless of the selected preview');
    if(engine==='chromium'){
      const pdf=await output.pdf({preferCSSPageSize:true});
      assert.equal((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)||[]).length,4,'the PDF contains exactly four physical sheets');
    }
  }finally{await output.close();}
  await page.locator('#printOverlap').fill('50');await printFrameReady(page);
  assert.match(await page.locator('#printSummary').textContent(),/3 columns × 2 rows.*6 pages/);
  assert.match(await page.locator('#printPageLabel').textContent(),/Page 1 of 6/,'layout changes reset the preview page');
  await page.locator('#printAlignment').uncheck();await printFrameReady(page);
  assert.equal(await page.locator('#printPreview').evaluate(frame=>frame.contentDocument.querySelectorAll('.print-alignment').length),0);
  await page.locator('#printOverlap').fill('0');await page.locator('#printReference').check();await printFrameReady(page);
  assert.match(await page.locator('#printSummary').textContent(),/2 columns × 2 rows.*4 pages/);
  assert.deepEqual(await page.locator('#printPreview').evaluate(frame=>[...frame.contentDocument.querySelectorAll('.print-calibration path')].map(p=>p.getPointAtLength(50).x-p.getPointAtLength(0).x)),[50,50,50,50]);
  await page.locator('#printPreview').evaluate(frame=>{frame.contentWindow.print=()=>{frame.dataset.printCalls='1';};});
  await page.keyboard.press('Control+p');
  assert.equal(await page.locator('#printPreview').getAttribute('data-print-calls'),'1');
  assert.equal(await run('(async()=>JSON.stringify({items,undoStack,redoStack,assets,storage:await readSavedWorkspace()}))()'),before,'tiling never changes the drawing or saved state');
  await page.locator('#printOverlap').fill('');assert.equal(await page.locator('#printDialogSubmit').isDisabled(),true);
  assert.match(await page.locator('#printDialogError').textContent(),/overlap/);
  await page.locator('#printMode').selectOption('fit');await printFrameReady(page);
  assert.equal(await page.locator('#printTileOptions').isVisible(),false);
  assert.equal(await page.locator('#printPageNav').isVisible(),false);
}));

test('print previews freeze live shapes and a cancelled snapshot cannot reopen or replace a later preview',async()=>app(async({page,run})=>{
  const script=`({refreshMs(){return 100;},children(s,style,w,h,editing){return [{type:'text',x:0,y:0,w,h,text:String(Date.now())+(editing?' EDIT CONTROL':'')}];}})`;
  await run(`items=[${JSON.stringify(smartFixture(script))}];setTool('select');selection=[0];editingSmartIdx=0;render();`);
  await page.locator('#menuBtn').click();await page.locator('[data-act="print"]').click();await printFrameReady(page);
  const snapshot=await run('printSnapshot.svg');assert.ok(!snapshot.includes('EDIT CONTROL'));
  const live=await run("smartChildrenCache.get('smart-test')?.kids[0]?.text");
  await page.waitForFunction(before=>__test.run("smartChildrenCache.get('smart-test')?.kids[0]?.text")!==before,live);
  await page.locator('#printMargin').fill('12');await printFrameReady(page);
  assert.equal(await run('printSnapshot.svg'),snapshot,'layout changes reuse the frozen drawing');
  await page.locator('#printDialogCancel').click();
  const slow=`({children(){const start=performance.now();while(performance.now()-start<150){}return [{type:'text',x:0,y:0,w:180,h:30,text:'Old snapshot'}];}})`;
  await run(`items=[${JSON.stringify(smartFixture(slow))}];selection=[];render();void openPrintDialog();`);
  await page.locator('#printDialogCancel').click();
  await run(`items=[${JSON.stringify(rectangle())}];render();openPrintDialog();`);await printFrameReady(page);
  assert.ok(!(await run('printSnapshot.svg')).includes('Old snapshot'));
  assert.equal(await page.locator('#printDialog[open]').count(),1);
}));

test('a custom deployment title is plain text and invalid titles do not partially apply settings',async()=>{
  const title='Team <b>sketchpad</b> & notes';
  await app(async({page,run})=>{
    assert.equal(await page.title(),title);
    assert.equal(await page.locator('head title b').count(),0);
    assert.equal(await run('features.workspace'),false);
    assert.equal(await page.locator('#settingsWarning').isVisible(),false);
  },{files:{'settings.json':JSON.stringify({version:1,title,features:{workspace:false}})}});
  for(const title of ['',42]){
    await app(async({page,run})=>{
      assert.equal(await page.title(),'Paperwire — Quick Sketches');
      assert.equal(await run('features.workspace'),true,'invalid settings never partially disable features');
      assert.equal(await page.locator('#settingsWarning').isVisible(),true);
    },{files:{'settings.json':JSON.stringify({title,features:{workspace:false}})}});
  }
});

test('deployment settings load a custom title and disable all optional features',async()=>app(async({page,run})=>{
  assert.equal(await page.title(),'Custom drawing app');
  assert.equal(await run('Object.values(features).every(value=>value===false)'),true);
  assert.equal(await page.locator('#shapeLibWrap').isVisible(),false);
  assert.equal(await run('performance.getEntriesByType("resource").some(e=>e.name.endsWith("shapes-library.json"))'),false);
  await page.locator('#menuBtn').click();
  for(const action of ['newWorkspace','newTab','openWorkspace','saveWorkspace'])assert.equal(await page.locator(`[data-act="${action}"]`).isVisible(),false);
  await page.keyboard.press('Escape');await page.locator('[data-tool="rect"]').click();
  const canvas=await page.locator('#canvas').boundingBox();
  await page.mouse.move(canvas.x+100,canvas.y+100);await page.mouse.down();
  await page.mouse.move(canvas.x+260,canvas.y+200,{steps:5});await page.mouse.up();
  assert.deepEqual(await run('items.map(it=>it.type)'),['rect']);
  await run('persistWorkspace()');await page.reload();await run('appReady');assert.equal(await page.title(),'Custom drawing app');
  assert.deepEqual(await run('items.map(it=>it.type)'),['rect']);
},{origin:'http://paperwire.test/custom',files:{'settings.json':JSON.stringify({version:1,title:'Custom drawing app',features:{workspace:false,shapeLibrary:false,shapeLibraryManagement:false,smartShapeAuthoring:false,smartComponents:false,networkIntegrations:false,iconify:false,customPrinting:false}})}}));

test('settings resolve before input, document restoration, or library loading',async()=>app(async({page,run})=>{
  let finish,started;
  const pending=new Promise(resolve=>{finish=resolve;}),requested=new Promise(resolve=>{started=resolve;});
  await page.route('**/settings.json',async route=>{started();await pending;await route.fulfill({contentType:'application/json',body:JSON.stringify({title:'Delayed deployment title',features:{workspace:false,shapeLibrary:false}})});});
  await run('persistWorkspace()');await page.reload({waitUntil:'domcontentloaded'});await requested;
  assert.equal(await page.evaluate(()=>document.body.inert),true);
  assert.equal(await page.title(),'Paperwire — Quick Sketches','document load does not imply asynchronous settings are ready');
  assert.equal(await page.evaluate(()=>__test.run('activeTabId')),null);
  await page.keyboard.press('r');assert.equal(await page.evaluate(()=>__test.run('ui.tool')),'pen');
  finish();await run('appReady');
  assert.equal(await page.title(),'Delayed deployment title');
  assert.equal(await page.evaluate(()=>document.body.inert),false);
  assert.equal(await page.locator('#shapeLibWrap').isVisible(),false);
  assert.equal(await page.locator('[data-act="newTab"]').getAttribute('hidden'),'');
}));

test('the standalone local HTML opens with defaults and no HTTP settings dependency',async()=>{
  const context=await browser.newContext();
  try{
    const page=await context.newPage(),requests=[],errors=[];
    page.on('request',request=>{if(/^https?:/.test(request.url()))requests.push(request.url());});
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(require('node:url').pathToFileURL(path.join(__dirname,'..','index.html')).href);
    await page.waitForFunction(()=>!document.body.inert);
    assert.equal(await page.locator('#settingsWarning').isVisible(),false);
    await page.locator('#menuBtn').click();await page.getByRole('menuitem',{name:'Add sketch',exact:true}).click();
    assert.equal(await page.locator('#tabbar .tab').count(),2);
    assert.deepEqual(requests,[]);assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('the bundled demo loads under a Pages subpath with inert previews and editable smart shapes',async()=>app(async({page,run})=>{
  await page.waitForFunction(count=>__test.run('shapeLibrary?.shapes.length')===count,demoShapeCount);
  assert.equal(await run('shapeLibrary.shapes.filter(t=>t.items.some(it=>it.type==="smart")).length'),7);
  await page.locator('#shapeLibBtn').click();
  await page.waitForFunction(count=>{
    const images=[...document.querySelectorAll('#shapeGrid img')];
    return images.length===count && images.every(img=>img.complete && img.naturalWidth===128);
  },demoShapeCount);
  assert.equal(await page.locator('#libraryDialog[open]').count(),0,'saved previews need no script consent');
  assert.equal(await page.evaluate(()=>window.__smartWorkerStarts),0,'browsing the demo runs no smart scripts');
  assert.equal(await run('shapeLibraryDirty'),false);
  const expectedWorking=JSON.parse(demoLibrary).workingCollection;
  const canonical={Clock:'builtin:clock:1',Chart:'builtin:chart:1','Live clock':'builtin:liveClock:1',Stopwatch:'builtin:stopwatch:1',Ruler:'builtin:ruler:1'};
  const expectedCategories={
    'builtin:clock:1':['Tools & time','Displays'],'builtin:chart:1':['Displays','Numbers'],
    'builtin:liveClock:1':['Tools & time','Displays'],'builtin:stopwatch:1':['Tools & time','Displays'],
    'builtin:ruler:1':['Workshop','Tools & time','Drawing']
  };
  const inspectDemo=()=>run(`({
    working:shapeLibrary.workingCollection,
    entries:shapeLibrary.shapes.map(entry=>({id:entry.id,name:entry.name,builtin:builtInShapeEntries.has(entry),
      canonical:builtInShapeLibrary.find(candidate=>candidate.id===entry.id)===entry,categories:effectiveLibraryCategories(entry),
      catalogCopies:libraryCatalogEntries().filter(candidate=>candidate.id===entry.id).length})),
    builtinCount:builtInShapeLibrary.length
  })`);
  const loaded=await inspectDemo();
  assert.equal(loaded.working.length,13);assert.deepEqual(loaded.working,expectedWorking,'the familiar working collection keeps its original order');
  assert.equal(loaded.entries.filter(entry=>entry.builtin).length,5);
  assert.equal(loaded.entries.filter(entry=>!entry.builtin).length,8);
  assert.equal(loaded.entries.some(entry=>entry.name.includes('(smart)')),false,'smart status is no longer repeated in entry names');
  assert.ok(loaded.entries.some(entry=>entry.name==='Finishing line'));
  await page.locator('#browseShapesBtn').click();
  await page.locator('#libraryCollection').selectOption('mine');
  assert.equal(await page.locator('#libraryBrowserGrid .shape-thumb').count(),8,'My shapes contains only the eight demo-owned entries');
  await page.locator('#libraryCollection').selectOption('builtin');
  assert.equal(await page.locator('#libraryBrowserGrid .shape-thumb').count(),loaded.builtinCount);
  for(const [name,id] of Object.entries(canonical)){
    const entry=loaded.entries.find(entry=>entry.name===name);
    assert.equal(entry.id,id);assert.equal(entry.builtin,true);assert.equal(entry.canonical,true);
    assert.equal(entry.catalogCopies,1,name+' appears once in the catalog');
    assert.deepEqual(entry.categories,expectedCategories[id]);
    const card=page.locator('#libraryBrowserGrid [data-entry-id='+JSON.stringify(id)+']');
    assert.equal(await card.count(),1);assert.equal(await card.locator('.library-origin').textContent(),'Built-in');
  }
  const exported=await downloadedJSON(page,run,'exportShapeLibrary()');
  assert.deepEqual(exported.workingCollection,expectedWorking);
  assert.deepEqual(exported.builtinCategoryTags,expectedCategories,'demo-specific memberships are exported separately from canonical definitions');
  const revision=await run('shapeLibraryRevision');await importLibrary(page,exported);
  await page.waitForFunction(previous=>__test.run('shapeLibraryRevision')>previous,revision);
  assert.deepEqual(await inspectDemo(),loaded,'export/reimport keeps categories, pins, order, and canonical identity without creating personal copies');
  assert.equal(await page.locator('#libraryDialog[open]').count(),0,'the canonical cached previews remain inert after reimport');
  assert.equal(await page.evaluate(()=>window.__smartWorkerStarts),0);
  if(await page.locator('#libraryBrowser').isVisible())await page.locator('#closeLibraryBrowserBtn').click();
  let canvas=await page.locator('#canvas').boundingBox();
  for(const [name,x] of [['Starboard tack boat',180],['Clock',480],['Chart',820]]){
    if(await page.locator('#shapePicker').isHidden()) await page.locator('#shapeLibBtn').click();
    await page.getByRole('button',{name:'Place '+name,exact:true}).click();
    canvas=await page.locator('#canvas').boundingBox();
    await page.mouse.click(canvas.x+x,canvas.y+240);
    await run('shapePlacementQueue');
  }
  assert.deepEqual(await run('items.map(it=>it.type)'),['polygon','polygon','ellipse','line','smart','smart']);
  canvas=await page.locator('#canvas').boundingBox();
  const clock=await run('items[4]');
  await page.mouse.dblclick(canvas.x+clock.x+clock.w/2,canvas.y+clock.y+clock.h/2);
  await page.waitForFunction(()=>__test.run('editingSmartIdx')===4);
  const minute=await run(`requestSmartCall(items[4],'handles',[items[4].state,items[4].w,items[4].h,smartResolvedStyle(items[4])]).then(hs=>hs.find(h=>h.id==='minute'))`);
  await page.mouse.move(canvas.x+clock.x+minute.x,canvas.y+clock.y+minute.y);
  await page.mouse.down();
  await page.waitForFunction(()=>__test.run('smartDrag?.handle')==='minute');
  await page.mouse.move(canvas.x+clock.x+clock.w*.85,canvas.y+clock.y+clock.h/2,{steps:5});
  await page.mouse.up();
  await run('smartHitSettled');
  assert.equal(await run('items[4].state.m'),15);
  await run('undo()');assert.equal(await run('items[4].state.m'),10);
  await run('redo()');assert.equal(await run('items[4].state.m'),15);
  const chart=await run('items[5]');
  await page.mouse.dblclick(canvas.x+chart.x+chart.w-40,canvas.y+chart.y+8);
  await page.waitForFunction(()=>__test.run('editingSmartIdx')===5);
  const add=await run(`requestSmartCall(items[5],'handles',[items[5].state,items[5].w,items[5].h,smartResolvedStyle(items[5])]).then(hs=>hs.find(h=>h.id==='add'))`);
  await page.mouse.click(canvas.x+chart.x+add.x,canvas.y+chart.y+add.y);
  await run('smartHitSettled');
  assert.equal(await run('items[5].state.values.length'),5);
  await run('undo()');assert.deepEqual(await run('items[5].state.values'),[30,60,45,80]);
  await run('persistWorkspace()');await page.reload();
  assert.equal(await run('items[4].state.m'),15,'edited demo shapes survive autosave/reload');
  assert.deepEqual(await run('items[5].state.values'),[30,60,45,80]);
}, {origin:'http://simplecanvas.test/paperwire',files:{'shapes-library.json':demoLibrary},init:()=>{
  const NativeWorker=window.Worker;
  window.__smartWorkerStarts=0;
  window.Worker=class extends NativeWorker{constructor(...args){super(...args);window.__smartWorkerStarts++;}};
}}));

test('a delayed demo response preserves a library imported during startup',async()=>app(async({page,run})=>{
  let finishDemo,requestStarted;
  const pendingDemo=new Promise(resolve=>{finishDemo=resolve;});
  const responseReady=new Promise(resolve=>{requestStarted=resolve;});
  await page.route('**/shapes-library.json',async route=>{
    requestStarted();await pendingDemo;
    await route.fulfill({contentType:'application/json',body:demoLibrary});
  });
  // Do not wait for the deliberately pending startup fetch's load event.
  await run('persistWorkspace()');await page.reload({waitUntil:'domcontentloaded'});
  await responseReady;
  await importLibrary(page,{shapes:[{name:'My imported shape',items:[rectangle()]}]});
  finishDemo();await page.waitForLoadState('networkidle');
  assert.deepEqual(await run('shapeLibrary.shapes.map(t=>t.name)'),['My imported shape']);
}));

test('released smart clicks survive nudges and color changes with independent undo entries',async()=>app(async({page,run})=>{
  const script=slowClickScript.replace('performance.now()+40;while(performance.now()<end){}return {n:',
    'performance.now()+180;while(performance.now()<end){}return {n:');
  for(const action of ['nudge','held nudge','color']){
    await run(`cancelGesture();items=[${JSON.stringify(smartFixture(script))}];setTool('select');selection=[0];editingSmartIdx=0;undoStack=[];redoStack=[];render();`);
    const b=await page.locator('#canvas').boundingBox();
    await page.mouse.click(b.x+150,b.y+150);
    await page.waitForFunction(()=>__test.run('smartSandboxPending.get(smartSandboxActive)?.message.fn')==='dragEdit');
    if(action==='nudge') await page.keyboard.press('ArrowRight');
    else if(action==='held nudge') await page.keyboard.down('ArrowRight');
    else await run(`applyStrokeColor('#0000ff',false)`);
    await run('smartHitSettled');
    assert.equal(await run('items[0].state.n'),1,action+' must retain the completed click');
    if(action==='held nudge') await page.keyboard.up('ArrowRight');
    assert.equal(await run('undoStack.length'),2,action+' and the handle action have separate history');
    await run('undo()');
    if(action==='held nudge'){
      assert.equal(await run('items[0].state.n'),1);assert.equal(await run('items[0].x'),100);
    }else{
      assert.deepEqual(await run('items[0].state'),{});
      assert.equal(await run(action==='nudge'?'items[0].x':'items[0].color'),action==='nudge'?101:'#0000ff');
    }
    await run('undo()');
    assert.deepEqual(await run('items[0].state'),{});assert.equal(await run('items[0].x'),100);
    assert.equal(await run('items[0].color'),'#000000');
    await run('redo();redo()');assert.equal(await run('items[0].state.n'),1);
  }
}));

test('loaded smart state enforces the hook contract before replacing a library or editing a sketch',async()=>app(async({page,run})=>{
  await importLibrary(page,{shapes:[{name:'Keep',items:[rectangle()]}]});
  await page.locator('.shape-thumb img').waitFor();
  const result=await run(`(()=>{
    const good=${JSON.stringify(smartFixture('({children(){return [];}})',{data:[true,null,7]}))};
    let deep={};for(let i=0;i<18;i++)deep={child:deep};
    const invalid=[{constructor:1},JSON.parse('{"__proto__":{}}'),{data:{prototype:1}},deep,[],null,{n:Infinity}];
    return {kept:normalizeScene([good],{},FORMAT_VERSION).items[0].state,
      rejected:invalid.map(state=>normalizeScene([{...good,state}],{},FORMAT_VERSION).items.length),
      missing:normalizeItem({...good,state:undefined},{}).state};
  })()`);
  assert.deepEqual(result,{kept:{data:[true,null,7]},rejected:Array(7).fill(0),missing:{}});
  await importLibrary(page,{shapes:[{name:'Invalid',items:[smartFixture('({children(){return [];}})',{constructor:1})]}]});
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('Invalid object'));
  assert.equal(await run('shapeLibrary.shapes[0].name'),'Keep');
}));

test('thumbnail and child SVG injection cannot reach the page on import, generation, or export',async()=>app(async({page,run,context})=>{
  await page.evaluate(()=>localStorage.setItem('security-sentinel','test-only'));
  const injected='100"/><image href="data:," onerror="window.leak=localStorage.getItem(\'security-sentinel\')"/><rect width="100';
  const script=`({children(){return [
    {type:'rect',x:0,y:0,w:${JSON.stringify(injected)},h:100,strokeOn:false,fill:true,fillColor:'#000000'},
    {type:'rect',x:0,y:0,w:20,h:30,fill:true,fillColor:'#22c55e',strokeOn:false}];}})`;
  const fixture=smartFixture(script);
  const fake='data:image/png;base64,'+Buffer.from('<svg onload="window.leak=1"/>').toString('base64');
  await importLibrary(page,{shapes:[{name:'Attack',items:[fixture],thumbnail:{version:1,png:fake,source:'forged'}}]});
  await page.locator('#libraryDialog[open]').waitFor();
  await page.locator('#libraryDialogSubmit').click();
  await page.locator('.shape-thumb img').waitFor();
  assert.equal(await page.evaluate(()=>window.leak),undefined);
  await run(`items=[${JSON.stringify(fixture)}];render();`);
  const svg=await run('itemsToSVGMarkup(items)');
  assert.ok(svg.includes('#22c55e'),'the valid sibling still exports');
  assert.ok(!svg.includes('onerror') && !svg.includes('<image'));
  const exported=await downloadedHTML(page,run);
  const view=await context.newPage();
  await view.setContent(exported);
  assert.equal(await view.evaluate(()=>window.leak),undefined);
  await view.close();
}));

test('opaque Worker policy blocks recovered network APIs, imports and storage over HTTP and file URLs',async()=>{
  const script=`({children(){
    const r=self.probeResult||(self.probeResult={});
    if(!r.started){r.started=true;
      WorkerGlobalScope.prototype.fetch.call(self,'https://blocked.test/fetch').then(()=>r.fetch='allowed',()=>r.fetch='blocked');
      import('https://blocked.test/module.js').then(()=>r.module='allowed',()=>r.module='blocked');
      try{WorkerGlobalScope.prototype.importScripts.call(self,'https://blocked.test/script.js');r.importScripts='allowed';}catch(e){r.importScripts='blocked';}
      try{Object.getOwnPropertyDescriptor(WorkerGlobalScope.prototype,'indexedDB').get.call(self).open('test');r.storage='allowed';}catch(e){r.storage='blocked';}
    }
    return [{type:'text',text:JSON.stringify(r),x:0,y:0,w:180,h:100,strokeOn:false,fill:false}];
  }})`;
  for(const origin of ['http://simplecanvas.test','file://'+path.resolve(__dirname,'..')]){
    await app(async({page,run,context})=>{
      const requests=[];
      await context.route('https://blocked.test/**',route=>{requests.push(route.request().url());return route.fulfill({contentType:'text/javascript',body:'export const ok=1;'});});
      await run(`window.policyProbe={script:${JSON.stringify(script)}};requestSmartCall(policyProbe,'children',[])`);
      await page.waitForTimeout(100);
      const kids=await run(`requestSmartCall(policyProbe,'children',[])`);
      const r=JSON.parse(kids[0].text);
      for(const key of ['fetch','module','importScripts','storage']) assert.equal(r[key],'blocked',key+' on '+origin);
      assert.deepEqual(requests,[],'no blocked request reaches the network');
    },{origin});
  }
});

test('malformed and oversized hook results cannot poison rendering, handles, state or export',async()=>app(async({page,run})=>{
  const script=`({children(s){if(!s.good)return {};return [{type:'rect',x:0,y:0,w:20,h:30,fill:true,fillColor:'#22c55e'}];},handles(){return {};}})`;
  await run(`items=[${JSON.stringify(smartFixture(script))},${JSON.stringify(rectangle('other'))}];setTool('select');selection=[0];editingSmartIdx=0;render();`);
  await page.waitForTimeout(100);
  await run('render()');
  const svg=await run('itemsToSVGMarkup(items)');
  assert.ok(svg.includes('#ffd166'),'the other drawing still exports');
  const values=await run(`(async()=>{
    const results=[];
    for(const [src,hook] of [
      ['({children(){return Array(1001).fill({type:"rect",x:0,y:0,w:1,h:1})}})','children'],
      ['({children(){return []},handles(){return [{id:"a",x:1,y:2},{id:"a",x:2,y:3}]}})','handles'],
      ['({children(){return []},initState(){return {tooLong:"x".repeat(4001)}}})','initState'],
      ['({children(){return []},dragEdit(){return []}})','dragEdit'],
      ['({children(){return []},initStyle(){return {w:"100"}}})','initStyle']
    ])results.push(await requestSmartCall(src,hook,[]));
    return results;
  })()`);
  assert.deepEqual(values,[null,null,null,null,{}]);
  await run('render()');
}));

test('cancel, delete, undo and tab switches invalidate delayed smart state updates',async()=>app(async({page,run})=>{
  const delayed=slowClickScript.replace('performance.now()+40;while(performance.now()<end){}return {n:', 'performance.now()+120;while(performance.now()<end){}return {n:');
  for(const action of ['cancelGesture()','deleteSelected()','undo()','newTab()']){
    await run(`cancelGesture();items=[${JSON.stringify(smartFixture(delayed))}];setTool('select');selection=[0];editingSmartIdx=0;undoStack=[];historyBefore=null;render();`);
    await page.waitForTimeout(100);
    const b=await page.locator('#canvas').boundingBox();await page.mouse.click(b.x+150,b.y+150);
    await page.waitForTimeout(60);await run(action);await page.waitForTimeout(200);
    if(action==='newTab()'){
      const stored=await run(`Array.from(tabDocuments.values()).flatMap(doc=>doc.items).filter(it=>it.uid==='smart-test').map(it=>it.state)`);
      assert.ok(stored.every(s=>!s.n),'old tab must not receive a stale state reply');
    } else assert.ok((await run('items.map(it=>it.state)')).every(s=>!s?.n),action+' must stop delayed updates');
  }
}));

test('smart drag release never applies the same movement twice, including an in-flight final move',async()=>app(async({page,run})=>{
  const script=`({
    children(){return [{type:'rect',x:0,y:0,w:180,h:180}];},
    handles(){return [{id:'move',x:50,y:50}];},hitEdit(){return 'move';},
    dragEdit(s,id,x,y){const end=performance.now()+40;while(performance.now()<end){}return {n:(s.n||0)+1,x,y};}
  })`;
  for(const settled of [true,false]){
    await run(`cancelGesture();items=[${JSON.stringify(smartFixture(script))}];setTool('select');selection=[0];editingSmartIdx=0;undoStack=[];historyBefore=null;render();`);
    const b=await page.locator('#canvas').boundingBox();
    await page.mouse.move(b.x+150,b.y+150);await page.mouse.down();
    await page.waitForFunction(()=>__test.run('smartCurrentPress?.mode')==='handle');
    await page.mouse.move(b.x+170,b.y+180);
    if(settled) await page.waitForFunction(()=>__test.run('items[0].state.n')===1);
    await page.mouse.up();await run('smartHitSettled');
    assert.deepEqual(await run('items[0].state'),{n:1,x:70,y:80});
    assert.equal(await run('undoStack.length'),1);
    await run('undo()');assert.deepEqual(await run('items[0].state'),{});
  }
}));

test('source edits update the library and bundled PNG, survive export, and preserve placed instances',async()=>app(async({page,run})=>{
  const oldScript=`({children(){return [{type:'rect',x:0,y:0,w:180,h:180,fill:true,fillColor:'#dc2626'}];}})`;
  const newScript=oldScript.replace('#dc2626','#3b82f6');
  await importLibrary(page,{shapes:[{name:'Color box',items:[smartFixture(oldScript,{n:7})]}]});
  await page.locator('#libraryDialogSubmit').click();await page.locator('.shape-thumb img').waitFor();
  const before=await downloadedJSON(page,run,'exportShapeLibrary()');
  await run("placeShapeAt(shapeLibrary.shapes[0],400,300)");
  if(await page.locator('#shapePicker').isHidden())await page.locator('#shapeLibBtn').click();
  await page.locator('#manageShapesBtn').click();
  await page.getByRole('button',{name:'Edit Color box',exact:true}).click();
  assert.equal(await page.locator('#smartObjectNameField').isHidden(),true);
  assert.equal(await page.locator('#smartObjectNameInput').isDisabled(),true);
  await page.locator('#smartObjectNameInput').evaluate(input=>{input.value='Renamed by a stale form';});
  await page.locator('#smartObjectScriptInput').fill('({initState(){return {};}})');
  await page.locator('#smartObjectDialogSubmit').click();
  await page.waitForFunction(()=>document.querySelector('#smartObjectDialogError').textContent.includes('children'));
  assert.equal(await run('shapeLibrary.shapes[0].items[0].script'),oldScript);
  await page.locator('#smartObjectScriptInput').fill(newScript);await page.locator('#smartObjectDialogSubmit').click();
  await page.waitForFunction(()=>!document.querySelector('#smartObjectDialog').open);
  const after=await downloadedJSON(page,run,'exportShapeLibrary()');
  assert.equal(after.shapes.length,1,'saving updates the entry instead of adding a duplicate');
  assert.equal(after.shapes[0].name,'Color box','saving source ignores changes to the hidden creation-only name field');
  assert.deepEqual(after.shapes[0].items[0],{...before.shapes[0].items[0],script:newScript});
  assert.notEqual(after.shapes[0].thumbnail.png,before.shapes[0].thumbnail.png);
  assert.equal(await run('items[0].script'),oldScript,'placed instances keep their own definition');
  await run('persistWorkspace()');await page.reload();await importLibrary(page,after);
  assert.equal(await page.locator('#libraryDialog[open]').count(),0,'the edited preview is bundled');
  await page.locator('#manageShapesBtn').click();
  await page.getByRole('button',{name:'Edit Color box',exact:true}).click();
  assert.equal(await page.locator('#smartObjectScriptInput').inputValue(),newScript);
  await page.locator('#smartObjectDialogCancel').click();
  await page.locator('#newSmartObjectBtn').click();
  assert.equal(await page.locator('#smartTemplateRow').isVisible(),true);
  assert.equal(await page.locator('#smartObjectNameField').isVisible(),true,'creation restores the name field after source editing');
  assert.equal(await page.locator('#smartObjectNameInput').isEnabled(),true);
  assert.equal(await page.locator('#smartObjectNameInput').evaluate(element=>element===document.activeElement),true,'new-shape creation still starts with its name');
  await page.locator('#smartObjectNameInput').fill('New shape');
  await page.locator('#smartObjectScriptInput').fill(newScript);await page.locator('#smartObjectDialogSubmit').click();
  await page.waitForFunction(()=>!document.querySelector('#smartObjectDialog').open);
  assert.deepEqual(await run('shapeLibrary.shapes.map(t=>t.name)'),['Color box','New shape']);
}));

test('each smart placement initializes fresh state and style, including imported definitions without state',async()=>app(async({page,run})=>{
  const script=`({initState(){return {stamp:Date.now()};},initStyle(){return {fillColor:'#3b82f6',size:5,w:120,h:80};},children(){return [];}})`;
  await run(`shapeLibrary=normalizeShapeLibrary({shapes:[{name:'Fresh',items:[${JSON.stringify(smartFixture(script,{stamp:0}))}]}]});items=[];undoStack=[];`);
  const start=Date.now();await run('placeShapeAt(shapeLibrary.shapes[0],300,200)');
  await page.waitForTimeout(5);await run('placeShapeAt(shapeLibrary.shapes[0],600,400)');
  const placed=await run('items');
  assert.equal(placed.length,2);
  assert.ok(placed[0].state.stamp>=start);assert.ok(placed[1].state.stamp>placed[0].state.stamp);
  for(const [i,it] of placed.entries()){
    assert.equal(it.fillColor,'#3b82f6');assert.equal(it.size,5);assert.equal(it.w,120);assert.equal(it.h,80);
    assert.equal(it.x+it.w/2,i===0?300:600);assert.equal(it.y+it.h/2,i===0?200:400);
  }
  assert.equal(await run('undoStack.length'),2);
  await run('undo()');assert.equal(await run('items.length'),1);
  await run('redo()');assert.equal(await run('items[1].state.stamp'),placed[1].state.stamp,'redo restores the initialized instance');
  assert.deepEqual(await run('shapeLibrary.shapes[0].items[0].state'),{stamp:0},'placement never changes the definition');
  await run(`const raw=${JSON.stringify(smartFixture(script))};delete raw.state;
    const imported=normalizeShapeLibrary({shapes:[{name:'Missing state',items:[raw]}]});placeShapeAt(imported.shapes[0],800,400);`);
  await page.waitForFunction(()=>__test.run('items.length')===3);
  assert.ok(await run('items[2].state.stamp')>=start);
}));

test('rapid smart placements keep their order and undo entries; cancellation discards pending initialization',async()=>app(async({page,run})=>{
  const script=`({n:0,initState(){const end=performance.now()+50;while(performance.now()<end){}return {n:++this.n};},children(){return [];}})`;
  await importLibrary(page,{shapes:[{name:'Fresh',items:[smartFixture(script)]}]});
  await page.locator('#libraryDialogCancel').click();
  await run('armShapeForPlacement(shapeLibrary.shapes[0])');
  const b=await page.locator('#canvas').boundingBox();await page.mouse.dblclick(b.x+400,b.y+300);
  await run('shapePlacementQueue');
  assert.deepEqual(await run('items.map(it=>it.state.n)'),[1,1],'each placement owns a fresh definition realm');
  assert.equal(await run('undoStack.length'),2);await run('undo()');assert.equal(await run('items.length'),1);
  await run('undo()');assert.equal(await run('items.length'),0);
  for(const action of ['newTab()','undo()','setTool("pen")','cancelGesture()','Escape','clearAll()']){
    await run('cancelGesture();items=[];undoStack=[];setTool("select");void placeShapeAt(shapeLibrary.shapes[0],300,200);');
    await page.waitForFunction(()=>__test.run('smartSandboxPending.get(smartSandboxActive)?.message.fn')==='initState');
    if(action==='Escape') await page.keyboard.press('Escape');else await run(action);
    await run('shapePlacementQueue');
    assert.equal(await run('items.length'),0,action+' cancels the pending placement');
    assert.ok(await run('Array.from(tabDocuments.values()).every(doc=>!doc.items.some(it=>it.type==="smart"))'),'no stale shape is added to a background tab');
  }
}));

// Compare production canvas/SVG/PNG output with the browser's own rendering of the source SVG.
// These fixtures are centered in their viewBox, matching the library's centering policy.
test('compound icon fills and short curved contours survive editing, persistence and image export',async()=>app(async({run})=>{
  const cases=[
    ['overlapping evenodd','<path fill-rule="evenodd" d="M0 0H16V24H0Z M8 0H24V24H8Z"/>',[[4,12],[12,12],[20,12]]],
    ['overlapping opposite winding','<path d="M0 0H16V24H0Z M8 0V24H24V0Z"/>',[[4,12],[12,12],[20,12]]],
    ['nested nonzero','<path d="M0 0H24V24H0Z M3 3H21V21H3Z M6 6V18H18V6Z M9 9V15H15V9Z"/>',[[1,12],[4,12],[7,12],[12,12]]],
    ['evenodd island','<path fill-rule="evenodd" d="M0 0H24V24H0Z M6 6H18V18H6Z M10 10H14V14H10Z"/>',[[2,2],[7,7],[12,12]]],
    ['nonzero island','<path d="M0 0H24V24H0Z M6 6V18H18V6Z M10 10H14V14H10Z"/>',[[2,2],[7,7],[12,12]]],
    ['disjoint contours','<path d="M0 0H8V24H0Z M16 0H24V24H16Z"/>',[[4,12],[12,12],[20,12]]],
    ['transformed curves','<g transform="translate(12 12) rotate(30) scale(1 .6)"><path fill="#36c" d="M-12 0C-12 -12 12 -12 12 0C12 12 -12 12 -12 0Z"/></g>',[[1,1],[12,12],[23,23]]],
    ['two-anchor lens','<path d="M0 12C0 0 24 0 24 12C24 24 0 24 0 12Z"/>',[[1,1],[12,4],[12,12],[12,20]]],
    ['one-anchor loop','<path d="M12 24C-12 -8 36 -8 12 24Z"/>',[[2,12],[12,2],[12,12],[22,12]]],
  ];
  for(const [name,body,samples] of cases){
    const r=await run(`(async()=>{
      const body=${JSON.stringify(body)},samples=${JSON.stringify(samples)},vb={left:0,top:0,width:24,height:24};
      const at=samples.map(([x,y])=>[x*5,y*5]);
      async function raster(url,width,height,points){
        const image=new Image();await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src=url;});
        const off=document.createElement('canvas');off.width=width;off.height=height;const x=off.getContext('2d');
        x.fillStyle='#fff';x.fillRect(0,0,width,height);x.drawImage(image,0,0,width,height);
        return points.map(([px,py])=>Array.from(x.getImageData(Math.round(px),Math.round(py),1,1).data));
      }
      const expected=await raster('data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 24 24">'+body+'</svg>'),120,120,at);
      const converted=svgIconToItems(body,vb);
      if(!converted.items)return {error:converted.error};
      const lib=normalizeShapeLibrary(JSON.parse(JSON.stringify({shapes:[{name:'Imported',items:converted.items}]})));
      items=normalizeScene(lib.shapes[0].items,{},FORMAT_VERSION).items;ensureUids(items);
      items.forEach(it=>translateItem(it,60,60));
      items.forEach((_,i)=>convertToCurve(i));
      setTool('select');selection=[];render();
      const canvasPixels=at.map(([x,y])=>Array.from(ctx.getImageData(x*dpr,y*dpr,1,1).data));
      const svg=await itemsToSVGMarkup(items,{width:120,height:120,background:false});
      const svgPixels=await raster('data:image/svg+xml,'+encodeURIComponent(svg),120,120,at);
      const bitmap=await createImageBitmap(await itemsToPngBlob(items,{background:false,scale:1,margin:0}));
      const png=document.createElement('canvas');png.width=png.height=120;const px=png.getContext('2d');
      px.fillStyle='#fff';px.fillRect(0,0,120,120);px.drawImage(bitmap,(120-bitmap.width)/2,(120-bitmap.height)/2);
      const pngPixels=at.map(([x,y])=>Array.from(px.getImageData(x,y,1,1).data));
      return {expected,canvasPixels,svgPixels,pngPixels};
    })()`);
    assert.equal(r.error,undefined,name+' converts');
    assert.deepEqual(r.canvasPixels,r.expected,name+' matches the original on canvas after roundtrip and point-edit conversion');
    assert.deepEqual(r.svgPixels,r.expected,name+' keeps its fill in SVG export');
    assert.deepEqual(r.pngPixels,r.expected,name+' keeps its fill in PNG export');
  }
}));

test('Close, Escape and library replacement invalidate pending icon imports',async()=>{
  for(const action of ['close','escape','replace'])await app(async({page,run})=>{
    let release,retryStarted,calls=0;
    const response=new Promise(resolve=>release=resolve),retry=new Promise(resolve=>retryStarted=resolve);
    const body='<rect width="24" height="24"/>';
    await page.route('https://api.iconify.design/**',async route=>{
      const url=new URL(route.request().url()),headers={'access-control-allow-origin':'*'};
      if(url.pathname==='/search')return route.fulfill({headers,contentType:'application/json',body:JSON.stringify({
        icons:['test:late'],collections:{test:{name:'Test',license:{title:'MIT',spdx:'MIT'}}}
      })});
      if(url.pathname==='/test.json'){
        if(++calls===1)return route.fulfill({status:503,headers,body:''});
        retryStarted();await response;
        return route.fulfill({headers,contentType:'application/json',body:JSON.stringify({width:24,height:24,icons:{late:{body}}})});
      }
      return route.fulfill({status:404,headers,body:''});
    });
    await run('openIconDialog()');await page.locator('#iconSearchInput').fill('late');await page.locator('#iconSearchBtn').click();
    await page.locator('#iconResults .shape-thumb').waitFor();
    assert.equal(await page.locator('#iconResults .shape-thumb').textContent(),'?');
    await page.locator('#iconResults .shape-thumb').click();await retry;
    if(action==='close')await page.locator('#iconDialogCancel').click();
    if(action==='escape')await page.keyboard.press('Escape');
    const replacement={shapes:[{name:'Replacement',items:[rectangle()]}]};
    await importLibrary(page,replacement);
    await page.waitForFunction(()=>__test.run('shapeLibrary?.shapes[0]?.name')==='Replacement');
    release();
    await page.waitForFunction(()=>__test.run("iconBodies.has('test:late')"));
    await run('new Promise(resolve=>setTimeout(resolve,30))');
    assert.deepEqual(await run('shapeLibrary.shapes.map(s=>s.name)'),['Replacement'],action+' cannot append to the replacement library');
    assert.equal(await run('shapeLibraryDirty'),false,'a cancelled import does not create unexported changes');
    if(action==='replace')await page.locator('#iconDialogCancel').click();
    await run('openIconDialog()');
    await page.locator('#iconResults .shape-thumb').click();
    await page.waitForFunction(()=>__test.run('shapeLibrary.shapes.length')===2);
    assert.deepEqual(await run('shapeLibrary.shapes.map(s=>s.name)'),['Replacement','late'],'a fresh explicit click can add the cached icon');
  });
});

test('a stale Load more response cannot replace a newer search or reopen a closed dialog',async()=>app(async({page,run})=>{
  let release,started;
  const response=new Promise(r=>release=r),pending=new Promise(r=>started=r);
  await page.route('https://api.iconify.design/**',async route=>{
    const url=new URL(route.request().url()),headers={'access-control-allow-origin':'*'};
    if(url.pathname==='/search'){
      const query=url.searchParams.get('query'),start=Number(url.searchParams.get('start'));
      if(start){started();await response;}
      const icons=query==='old' && !start?Array.from({length:96},(_,i)=>'test:old-'+i):['test:'+(start?'late':'new')];
      return route.fulfill({headers,contentType:'application/json',body:JSON.stringify({icons,collections:{test:{name:'Test',license:{spdx:'MIT'}}}})});
    }
    return route.fulfill({status:404,headers,body:''});
  });
  await run('openIconDialog()');await page.locator('#iconSearchInput').fill('old');await page.locator('#iconSearchBtn').click();
  await page.locator('#iconResults .shape-entry').first().waitFor();await page.locator('#iconLoadMore').click();await pending;
  await page.locator('#iconSearchInput').fill('new');await page.locator('#iconSearchBtn').click();
  await page.waitForFunction(()=>document.querySelectorAll('#iconResults .shape-name').length===1 && document.querySelector('#iconResults .shape-name').textContent==='new');
  await page.locator('#iconDialogCancel').click();release();
  await run('new Promise(r=>setTimeout(r,50))');await run('openIconDialog()');
  await page.waitForFunction(()=>document.querySelector('#iconResults .shape-name')?.textContent==='new');
  assert.deepEqual(await page.locator('#iconResults .shape-name').allTextContents(),['new']);
  assert.equal(await page.locator('#iconLoadMore').isVisible(),false);
}));

test('static simplification applies transforms, reports omissions, and never admits animations or empty results',async()=>app(async({run})=>{
  const r=await run(`(()=>{
    const vb={left:0,top:0,width:24,height:24};
    const body='<defs><pattern id="p" width="1" height="1"/></defs><g transform="translate(12 12) scale(2 1)"><rect x="-4" y="-4" width="8" height="8" style="fill:url(#p);stroke:red;stroke-width:1;opacity:.5;stroke-dasharray:2 2"/><text>omitted</text><use href="#x"/></g>';
    const normal=svgIconToItems(body,vb),simple=svgIconToItems(body,vb,{simplify:true});
    const animations=[
      '<rect width="24" height="24"><animate attributeName="x" values="0;2" dur="1s"/></rect>',
      '<g><set attributeName="fill" to="red"/><rect width="24" height="24"/></g>',
      '<style>@keyframes spin {to{opacity:0}}</style><rect width="24" height="24"/>',
      '<rect width="24" height="24" style="animation:spin 1s infinite"/>',
      '<rect width="24" height="24" style="transition:fill 1s"/>',
    ].map(body=>[svgIconToItems(body,vb),svgIconToItems(body,vb,{simplify:true})]);
    return {normal,simple,animations,empty:svgIconToItems('<text>only text</text>',vb,{simplify:true}),
      unsafe:svgIconToItems('<script>throw 1</script><rect width="24" height="24"/>',vb,{simplify:true}),
      faint:svgIconToItems('<rect width="24" height="24"/><circle r="10" opacity=".01"/>',vb),
      zeroStroke:svgIconToItems('<rect width="24" height="24" fill="red" stroke="blue" stroke-width="0"/>',vb),
      stylesInDefs:svgIconToItems('<defs><style>.red{fill:red}</style></defs><rect class="red" width="24" height="24"/>',vb,{simplify:true})};
  })()`);
  assert.equal(r.normal.canSimplify,true);assert.ok(r.simple.items?.length);assert.ok(r.simple.warnings.length>=4);
  const b=await run(`bbox(${JSON.stringify(r.simple.items[0])},false)`);assert.equal(b.w,80);assert.equal(b.h,40,'non-uniform transforms are applied to geometry');
  for(const pair of r.animations)for(const result of pair){assert.match(result.error,/Animated/);assert.equal(result.items,undefined);assert.equal(result.canSimplify,undefined);}
  assert.match(r.empty.error,/no drawable/);assert.match(r.unsafe.error,/scripts/);
  assert.ok(r.faint.warnings.some(w=>/transparent layers/.test(w)),'omitting faint layers is disclosed');
  assert.equal(r.zeroStroke.items[0].strokeOn,false,'zero-width SVG strokes stay invisible');
  assert.ok(r.stylesInDefs.warnings.includes('Stylesheet rules were omitted.'),'CSS rules inside definitions require the same disclosure');
}));

const pointEditSquare = {type:'polygon',uid:'sq',closed:true,color:'#1f2937',size:2,strokeOn:true,fill:true,fillColor:'#ffd166',
  points:[{x:100,y:100},{x:300,y:100},{x:300,y:300},{x:100,y:300}]};

test('Point-Edit: a click on the outline adds an anchor (undoable), click-drag adds and moves it', async () => app(async ({page,run}) => {
  await run(`items=[${JSON.stringify(pointEditSquare)}];setTool('select');selection=[0];pointEditIdx=0;activeAnchor=null;render();`);
  const box = await page.locator('#canvas').boundingBox();
  const undoBefore = await run('undoStack.length');
  await page.mouse.click(box.x+150, box.y+101);
  assert.deepEqual(await run('items[0].points.map(p=>[p.x,p.y])'), [[100,100],[150,100],[300,100],[300,300],[100,300]]);
  assert.equal(await run('activeAnchor'), 1, 'the new anchor is the active one');
  assert.equal(await run('undoStack.length'), undoBefore+1, 'one undo entry');
  await run('undo()');
  assert.equal(await run('items[0].points.length'), 4);
  await run('selection=[0];pointEditIdx=0;render()');
  await page.mouse.move(box.x+300, box.y+200);
  await page.mouse.down();
  await page.mouse.move(box.x+330, box.y+200, {steps:4});
  await page.mouse.move(box.x+350, box.y+200, {steps:4});
  await page.mouse.up();
  const pts = await run('items[0].points.map(p=>[p.x,p.y])');
  assert.equal(pts.length, 5);
  assert.deepEqual(pts[2], [350,200], 'inserted between the right-hand corners and dragged out');
  assert.equal(await run('pointEditIdx'), 0, 'still in Point-Edit');
}));

test('Point-Edit: Delete, Alt+click and the x button remove an anchor, never below the minimum', async () => app(async ({page,run}) => {
  const five = {...pointEditSquare, points:[...pointEditSquare.points, {x:50,y:200}]};
  await run(`items=[${JSON.stringify(five)}];setTool('select');selection=[0];pointEditIdx=0;activeAnchor=null;render();`);
  const box = await page.locator('#canvas').boundingBox();
  await page.mouse.click(box.x+50, box.y+200);          // pick the extra anchor
  assert.equal(await run('activeAnchor'), 4);
  await page.keyboard.press('Delete');
  assert.equal(await run('items.length'), 1, 'Delete removes the anchor, not the shape');
  assert.equal(await run('items[0].points.length'), 4);
  await run('undo(); selection=[0]; pointEditIdx=0; render()');
  assert.equal(await run('items[0].points.length'), 5, 'undo restores it');
  await page.keyboard.down('Alt');
  await page.mouse.click(box.x+50, box.y+200);
  await page.keyboard.up('Alt');
  assert.equal(await run('items[0].points.length'), 4, 'Alt+click removes an anchor directly');
  await page.mouse.click(box.x+300, box.y+300);          // pick a corner, then its x button
  assert.equal(await run('activeAnchor'), 2);
  await page.mouse.click(box.x+316, box.y+284);
  assert.deepEqual(await run('items[0].points.map(p=>[p.x,p.y])'), [[100,100],[300,100],[100,300]], 'x button removes it');
  await page.mouse.click(box.x+100, box.y+100);
  assert.equal(await run('anchorDeleteButtonPos()'), null, 'no x button at the minimum');
  await page.keyboard.press('Delete');
  assert.equal(await run('items[0].points.length'), 3, 'a closed shape keeps at least 3 anchors');
  assert.equal(await run('items.length'), 1);
}));

test('inserting an anchor into a curve keeps its exact shape', async () => app(async ({run}) => {
  const worst = await run(`(()=>{
    const it = {type:'polygon', closed:false, color:'#000000', size:2, strokeOn:true, fill:false,
      points:[{x:0,y:0,c1:{x:40,y:-80}}, {x:200,y:0,c2:{x:160,y:90}}]};
    const before = JSON.parse(JSON.stringify(it));
    insertAnchor(it, 0, 0.37);
    let worst = 0;
    for(const s of polyCurveSegments(it)) for(let t=0; t<=1; t+=0.05){
      const x = cubicPoint(s.a.x,s.c1.x,s.c2.x,s.b.x,t), y = cubicPoint(s.a.y,s.c1.y,s.c2.y,s.b.y,t);
      worst = Math.max(worst, nearestOnOutline(before, x, y).d);
    }
    return worst;
  })()`);
  assert.ok(worst < 0.05, `split curve deviates ${worst}px from the original`);
}));

test('double-click exit preserves Redo and the oldest Undo entry when history is full',async()=>{
  for(const full of [false,true])await app(async({page,run})=>{
    await run(`items=[${JSON.stringify(pointEditSquare)}];setTool('select');selection=[0];
      for(let i=0;i<${full?80:1};i++){beginHistory();items[0].fillColor=${full?"'#'+i.toString(16).padStart(6,'0')":"'#00ff00'"};commitHistory();}
      ${full?'':'undo();'}selection=[0];pointEditIdx=0;activeAnchor=null;render();`);
    const before=await run('({items:clone(items),undo:undoStack.slice(),redo:redoStack.slice()})');
    const box=await page.locator('#canvas').boundingBox();await page.mouse.dblclick(box.x+150,box.y+101);
    const after=await run('({items:clone(items),undo:undoStack.slice(),redo:redoStack.slice()})');
    assert.deepEqual(after,before,'withdrawing an insertion restores geometry and both complete histories');
    assert.equal(await run('pointEditIdx'),null);
    if(full){
      await run('for(let i=0;i<80;i++)undo()');
      assert.equal(await run('items[0].fillColor'),pointEditSquare.fillColor,'even the oldest edit is still undoable');
    }else{
      await run('redo()');assert.equal(await run('items[0].fillColor'),'#00ff00','Redo still restores the real recolor');
    }
  });
});

test('font controls edit selected tables and mixed text selections with undo and file persistence',async()=>app(async({page,run})=>{
  const table={type:'table',uid:'table',x:100,y:100,w:240,h:160,rows:1,cols:1,size:2,color:'#000000',
    fontFamily:'sans',fontSize:28,texts:[['Table']]};
  await run(`items=[${JSON.stringify(table)},${JSON.stringify(wrappedText)},${JSON.stringify(smartFixture('({children(){return [];}})'))},${JSON.stringify(rectangle())}];
    setTool('select');selection=[0];render();`);
  const defaults=await run('({family:ui.fontFamily,size:ui.fontSize})');
  await page.locator('#fontSize').selectOption('48');
  assert.equal(await run('items[0].fontSize'),48,'the selected table changes, rather than drawing defaults');
  assert.equal(await run('undoStack.length'),1);
  await page.locator('#fontFamily').selectOption('serif');
  assert.equal(await run('items[0].fontFamily'),'serif');
  await run('undo()');assert.equal(await run('items[0].fontFamily'),'sans');
  assert.equal(await run('items[0].fontSize'),48);
  await run('redo()');assert.equal(await run('items[0].fontFamily'),'serif');
  await run('selection=[0,1,2,3];render()');
  await page.locator('#fontFamily').selectOption('mono');
  await page.locator('#fontSize').selectOption('36');
  for(const it of await run('items.slice(0,3)')){
    assert.equal(it.fontFamily,'mono');assert.equal(it.fontSize,36);
    assert.match(it.font,/36px .*monospace/);
  }
  assert.equal(await run('items[3].font'),undefined,'non-text shapes do not acquire font fields');
  assert.deepEqual(await run('({family:ui.fontFamily,size:ui.fontSize})'),defaults,'editing a selection preserves drawing defaults');
  const exported=await downloadedJSON(page,run,'exportProject()');
  await run('persistWorkspace()');await page.reload();await run(`applySketchToActiveTab(${JSON.stringify(exported.items)},${JSON.stringify(exported.assets)})`);
  assert.deepEqual(await run('items.slice(0,3).map(it=>[it.fontFamily,it.fontSize])'),[['mono',36],['mono',36],['mono',36]]);
}));

test('toolbar popovers stay exclusive and retain color-panel, accessibility and menu keyboard behavior',async()=>app(async({page,run})=>{
  await run("setTool('table')");
  const popovers={strokeBtn:'strokePicker',fillBtn:'fillPicker',textColorBtn:'textColorPicker',sizeBtn:'sizePicker',
    tableBtn:'tablePicker',shapeLibBtn:'shapePicker',menuBtn:'menu'};
  async function onlyOpen(button){
    const state=await page.evaluate(popovers=>Object.entries(popovers).map(([button,id])=>({button,
      open:!document.getElementById(id).hidden,expanded:document.getElementById(button).getAttribute('aria-expanded')})),popovers);
    assert.deepEqual(state.filter(p=>p.open).map(p=>p.button),button?[button]:[]);
    for(const p of state)assert.equal(p.expanded,String(p.button===button),p.button+' reflects the open state');
    assert.equal(await page.locator('#menuBtn').evaluate(b=>b.classList.contains('active')),button==='menuBtn');
  }
  await page.locator('#strokeBtn').click();await onlyOpen('strokeBtn');
  await page.locator('#strokePicker .cswatch.custom').click();
  assert.equal(await page.locator('#strokePicker .cpanel').isVisible(),true);
  for(const button of ['tableBtn','menuBtn','fillBtn','textColorBtn','sizeBtn','shapeLibBtn','strokeBtn']){
    await page.locator('#'+button).click();await onlyOpen(button);
  }
  assert.equal(await page.locator('#strokePicker .cpanel').isVisible(),false,'opening another popover resets the custom-color panel');
  await page.mouse.click(1,1);await onlyOpen(null);
  await page.locator('#tableBtn').click();
  await page.locator('#menuBtn').focus();await page.keyboard.press('ArrowDown');await onlyOpen('menuBtn');
  const actions=page.locator('#menu button[data-act]');
  assert.equal(await actions.first().evaluate(b=>b===document.activeElement),true);
  await page.keyboard.press('ArrowDown');assert.equal(await actions.nth(1).evaluate(b=>b===document.activeElement),true);
  await page.keyboard.press('Escape');await onlyOpen(null);
  assert.equal(await page.locator('#menuBtn').evaluate(b=>b===document.activeElement),true);
}));
