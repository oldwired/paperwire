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

test('external PNG paste still wins over the internal clipboard when JSON is invalid', async () => app(async ({page,run}) => {
  await run(`items=[${JSON.stringify(rectangle())}];setTool('select');selection=[0];copySelection();`);
  await page.evaluate(async()=>{
    const c=document.createElement('canvas');c.width=c.height=20;
    const blob=await new Promise(resolve=>c.toBlob(resolve));
    const dt=new DataTransfer();dt.setData('text/plain','{"app":"SimpleCanvas","kind":"objects","version":2,"items":[{"type":"broken"}]}');
    dt.items.add(new File([blob],'external.png',{type:'image/png'}));
    window.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,cancelable:true,bubbles:true}));
  });
  await page.waitForFunction(()=>__test.run('items.length')===2);
  assert.deepEqual(await run('items.map(it=>it.type)'),['rect','image']);
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

test('click cycling resets after deletion, layer reordering, and nudging', async () => app(async ({page,run}) => {
  await run(`items=${JSON.stringify([rectangle('lower'),rectangle('upper')])};setTool('select');`);
  const box=await page.locator('#canvas').boundingBox();
  const click=()=>page.mouse.click(box.x+170,box.y+145);
  await click();assert.deepEqual(await run('selectedUids()'),['upper']);
  await page.keyboard.press('Delete');await click();
  assert.deepEqual(await run('selectedUids()'),['lower']);
  await run('undo()');await click();
  assert.deepEqual(await run('selectedUids()'),['upper']);
  await click();assert.deepEqual(await run('selectedUids()'),['lower']);
  await run('bringToFront()');await click();
  assert.deepEqual(await run('selectedUids()'),['lower']);
  await page.keyboard.press('ArrowRight');await click();
  assert.deepEqual(await run('selectedUids()'),['lower'],'a scene edit resets the cycle even when the hit stack is unchanged');
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

// ---------- secondary clicks on the canvas ----------
// The native menu is always suppressed. A secondary press -- the right button, or Control+click on a
// Mac, which browsers deliver as a primary-button press with ctrlKey followed by a contextmenu event
// -- never starts a gesture; its one job is finishing the polygon in progress. Duplicate-drag is
// therefore ⌘+drag on a Mac. Events go straight to the canvas here, so the checks do not depend on
// the host OS's own Control-click handling.

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

test('double-click keeps a selected lower smart component beneath a shape or another component', async () => app(async ({page,run}) => {
  for(const top of [rectangle('top'),overlappingSmart('top')]){
    const scene=[rectangle('bottom'),overlappingSmart('selected'),top];
    await seedOverlap(run,scene);
    let box=await page.locator('#canvas').boundingBox();
    await page.mouse.click(box.x+190,box.y+160);
    box=await page.locator('#canvas').boundingBox();
    await page.mouse.click(box.x+190,box.y+160);
    assert.deepEqual(await run('selectedUids()'),['selected'],'separate clicks reach the lower component');
    box=await page.locator('#canvas').boundingBox();
    await page.mouse.dblclick(box.x+190,box.y+160);
    await page.waitForFunction(()=>__test.run('editingSmartIdx')===1);
    assert.deepEqual(await run('selectedUids()'),['selected']);
    assert.deepEqual(await run('items'),scene);
  }
}));

test('ordinary overlapping shapes keep their cycled double-click target', async () => app(async ({page,run}) => {
  const scene=['bottom','middle','top'].map(uid=>rectangle(uid));
  await seedOverlap(run,scene);
  const box=await page.locator('#canvas').boundingBox();
  await page.mouse.dblclick(box.x+190,box.y+160);
  assert.deepEqual(await run('selectedUids()'),['middle']);
  assert.equal(await run('pointEditIdx'),1);
  assert.equal(await run('items[1].type'),'polygon');
  assert.deepEqual(await run('[items[0],items[2]]'),[scene[0],scene[2]]);
}));

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

// ---------- Iconify icon import ----------

const smartFixture = (script, state={}) => ({type:'smart',uid:'smart-test',x:100,y:100,w:180,h:180,
  color:'#000000',fillColor:'#dc2626',strokeOn:true,fill:false,textColor:'#000000',size:2,
  fontFamily:'sans',fontSize:12,font:'600 12px sans-serif',script,state});
async function importLibrary(page, library){
  await page.locator('#shapeLibraryInput').setInputFiles({name:'library.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(library))});
}

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
function gestureRotation(gesture,w,h){
  const end=gesture.latest||gesture.end,start=gesture.down;
  const delta=Math.atan2(end.local.y-h/2,end.local.x-w/2)-Math.atan2(start.local.y-h/2,start.local.x-w/2);
  return Math.atan2(Math.sin(delta),Math.cos(delta));
}

async function exportClick(preview,host,x,y){const p=await exportedPoint(host,x,y);await preview.mouse.click(p.x,p.y);}

async function exportRotate(preview,host,w,h,angle,release=true){
  const radius=h/2+30,a=await exportedPoint(host,w/2,-30);
  const b=await exportedPoint(host,w/2+Math.sin(angle)*radius,h/2-Math.cos(angle)*radius);
  const gesture=await recordExportGesture(host,async()=>{
    await preview.mouse.move(a.x,a.y);await preview.mouse.down();await preview.mouse.move(b.x,b.y,{steps:6});
    if(release)await preview.mouse.up();
  });
  assert.ok(gesture.latest,'rotation must deliver a pointermove');
  if(release)assert.ok(gesture.up,'released rotation must deliver a pointerup');
  assert.ok(Math.abs(gesture.end.screen.x-b.x)<=1 && Math.abs(gesture.end.screen.y-b.y)<=1,'rotation reaches the requested screen endpoint within one CSS pixel');
  return gesture;
}

test('editor and HTML Shift-rotation snap to absolute 15-degree steps, including pre-rotated groups',async()=>app(async({page,run,context})=>{
  await run(`items=[{...${JSON.stringify(rectangle())},rotation:20*Math.PI/180}];setTool('select');selection=[0];render();`);
  const pivot=await run(`rotationPivotFor(selection)`),canvas=await page.locator('#canvas').boundingBox();
  const radius=pivot.cy-pivot.handleY;
  await page.mouse.move(canvas.x+pivot.cx+Math.sin(pivot.rotation)*radius,canvas.y+pivot.cy-Math.cos(pivot.rotation)*radius);
  await page.mouse.down();await page.keyboard.down('Shift');
  await page.mouse.move(canvas.x+pivot.cx+Math.sin(38*Math.PI/180)*radius,canvas.y+pivot.cy-Math.cos(38*Math.PI/180)*radius,{steps:5});
  assert.ok(Math.abs(await run('items[0].rotation')-Math.PI/4)<1e-6,'the editor snaps 38 degrees to 45 degrees');
  await page.keyboard.up('Shift');await page.mouse.up();
  assert.ok(Math.abs(await run('items[0].rotation')-Math.PI/4)<1e-6,'releasing Shift without moving retains the editor angle');

  const script=`({exportBehavior:{rotate:true},children(s,style,w,h){return [{type:'rect',x:0,y:0,w,h,fill:true,fillColor:'#dbeafe'}];}})`;
  await run(`items=[{...${JSON.stringify(smartFixture(script))},x:350,y:220,rotation:20*Math.PI/180,group:'snap',groupRotation:15*Math.PI/180},
    {...${JSON.stringify(rectangle('sibling'))},x:650,group:'snap',groupRotation:15*Math.PI/180}];selection=[];render();`);
  const {preview,errors}=await openExport(page,run,context),shape=preview.locator('[data-smart-index="0"]');
  await preview.waitForFunction(()=>document.querySelector('[data-smart-ready="true"]'));
  const angle=()=>shape.evaluate(el=>{const m=el.firstElementChild.getScreenCTM();return Math.atan2(m.b,m.a)*180/Math.PI;});
  assert.ok(Math.abs(await angle()-35)<1e-4,'the export starts with the combined own and group rotation');
  await exportClick(preview,shape,90,90);
  await preview.keyboard.down('Shift');await exportRotate(preview,shape,180,180,3*Math.PI/180,false);
  assert.ok(Math.abs(await angle()-45)<1e-4,'HTML snaps the visible 38-degree angle to 45, rather than snapping its drag delta');
  await preview.keyboard.up('Shift');await preview.mouse.up();
  assert.ok(Math.abs(await angle()-45)<1e-4,'pointerup keeps the last snapped angle when Shift has been released');
  const freeRotation=await exportRotate(preview,shape,180,180,-7*Math.PI/180);
  const freeAngle=45+gestureRotation(freeRotation,180,180)*180/Math.PI;
  assert.ok(Math.abs(await angle()-freeAngle)<1e-4,'rotation follows the received pointer without Shift');
  await preview.keyboard.down('Shift');await exportClick(preview,shape,90,-30);await preview.keyboard.up('Shift');
  assert.ok(Math.abs(await angle()-freeAngle)<1e-4,'a stationary handle click does not change the angle');
  await preview.keyboard.down('Shift');await exportRotate(preview,shape,180,180,-76*Math.PI/180);await preview.keyboard.up('Shift');
  assert.ok(Math.abs(await angle()+45)<1e-4,'negative angles use the same absolute snapping grid');
  await preview.keyboard.down('Shift');await exportRotate(preview,shape,180,180,43*Math.PI/180);await preview.keyboard.up('Shift');
  assert.ok(Math.abs(await angle())<1e-4,'snapping also crosses zero cleanly');
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

const demoLibrary = fs.readFileSync(path.join(__dirname,'..','examples','demo-shapes-library.json'),'utf8');
const demoShapeCount = JSON.parse(demoLibrary).shapes.length;

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

// Compare production canvas/SVG/PNG output with the browser's own rendering of the source SVG.
// These fixtures are centered in their viewBox, matching the library's centering policy.

const pointEditSquare = {type:'polygon',uid:'sq',closed:true,color:'#1f2937',size:2,strokeOn:true,fill:true,fillColor:'#ffd166',
  points:[{x:100,y:100},{x:300,y:100},{x:300,y:300},{x:100,y:300}]};

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
