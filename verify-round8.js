// Round8 acceptance driver: chromium --remote-debugging-pipe, 390x844, 2D fallback path.
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const root = process.cwd(), outDir = path.join(root, 'artifacts', 'round8');
fs.mkdirSync(outDir, { recursive: true });
const profile = path.join(root, '.round8-verify');
const browser = spawn('/snap/bin/chromium', ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
  '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run',
  '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
  '--disable-features=Translate,MediaRouter,OptimizationHints',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
  '--remote-debugging-pipe', `--user-data-dir=${profile}`, 'about:blank'],
  { cwd: root, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let nextId = 0, buffer = '', session = null, stderr = '';
const pending = new Map(), exceptions = [];
browser.stderr.on('data', b => { stderr += b.toString(); });
browser.on('exit', () => { for (const { reject } of pending.values()) reject(new Error('Chromium exited: ' + stderr.slice(-1500))); pending.clear(); });
function cdp(method, params = {}, sid = session) {
  return new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject });
    browser.stdio[3].write(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) }) + '\0');
  });
}
browser.stdio[4].on('data', chunk => {
  buffer += chunk.toString(); let n;
  while ((n = buffer.indexOf('\0')) >= 0) {
    const raw = buffer.slice(0, n); buffer = buffer.slice(n + 1);
    if (!raw) continue;
    let m; try { m = JSON.parse(raw); } catch { continue; }
    if (m.id) {
      const p = pending.get(m.id); if (!p) continue; pending.delete(m.id);
      if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') {
      exceptions.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description || ''));
    }
  }
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function until(expression, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await evaluate(expression)) return true; await sleep(50); }
  throw new Error('Timed out: ' + expression);
}
async function click(id) {
  const p = await evaluate(`(()=>{const r=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...p });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...p });
}
async function screenshot(name, full = false) {
  const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full });
  fs.writeFileSync(path.join(outDir, name), Buffer.from(r.data, 'base64'));
}
async function step(sec) {
  await evaluate(`(()=>{const t=__maluTest;t.pause(false);const n=Math.round(${sec}*60);for(let i=0;i<n&&t.state.phase==='playing';i++)t.simulation(1/60);t.pause(true);return t.state.elapsed;})()`);
}
(async () => {
  const checks = {};
  try {
    checks.chromium = (await cdp('Browser.getVersion', {}, null)).product;
    const target = (await cdp('Target.createTarget', { url: 'about:blank' }, null)).targetId;
    session = (await cdp('Target.attachToTarget', { targetId: target, flatten: true }, null)).sessionId;
    await cdp('Page.enable'); await cdp('Runtime.enable');
    await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await cdp('Page.navigate', { url: 'file://' + path.join(root, 'index.html') + '?selftest' });
    await until('!!window.__maluTest && document.readyState==="complete"', 15000);
    await sleep(1500);
    checks.render = await evaluate('window.__maluRender ? {mode: window.__maluRender.mode, nonblank: window.__maluRender.lastCheck && window.__maluRender.lastCheck.nonblank} : "n/a"');

    // 0. props removed + snake registered
    checks.props_gone = await evaluate(`(()=>{return {hasRoadsideProps: 'roadsideProps' in __maluTest, htmlHasLight: document.body.innerHTML.includes('traffic-light') || document.body.innerHTML.includes('traffic-cone'), snakeFee: __maluTest.TYPES.snake.fee, snakeName: __maluTest.TYPES.snake.name, scheduleHasSnake: JSON.stringify(__maluTest.SCHEDULE).includes('snake'), sidebarSnake: !!document.querySelector('[data-kind="snake"]'), sidebarCount: document.querySelector('.obstacle-title span') ? document.querySelector('.obstacle-title span').textContent : null};})()`);
    checks.sidebar = await evaluate(`(()=>{const s=document.querySelector('#observatory');return {display:getComputedStyle(s).display, expanded:document.querySelector('#observatory-toggle').getAttribute('aria-expanded')};})()`);
    await screenshot('r8-home-full.png', true);

    // 1. start + music still works
    await click('start');
    await sleep(1200);
    checks.music = await evaluate(`(()=>{const m=__maluTest.music;return {ctx: m.context?m.context.state:'none', gain: m.gain?+m.gain.gain.value.toFixed(2):null, bpm:m.bpm};})()`);

    // 2. ghost from bus HEAD: hidden first, then visible at head side
    await evaluate(`__maluTest.spawn('ghost')`);
    await step(1.0);
    checks.ghost_before = await evaluate(`(()=>{const o=__maluTest.state.obstacles.find(o=>o.kind==='ghost');return o?{x:+o.x.toFixed(2), z:+o.z.toFixed(1), active:o.active, visible:__maluTest.ghostVisible(o)}:null;})()`);
    await screenshot('r8-ghost-hidden.png');
    for (let i = 0; i < 12; i++) {
      await step(0.5);
      const g = await evaluate(`(()=>{const o=__maluTest.state.obstacles.find(o=>o.kind==='ghost');return o?{x:+o.x.toFixed(2), z:+o.z.toFixed(1), active:o.active, visible:__maluTest.ghostVisible(o)}:null;})()`);
      if (g && g.visible) { checks.ghost_after = g; break; }
      checks.ghost_after = g;
    }
    await screenshot('r8-ghost-visible.png');

    // 3. snake: collect both variants, watch x movement
    const variants = {};
    for (let tries = 0; tries < 6 && Object.keys(variants).length < 2; tries++) {
      await evaluate(`__maluTest.spawn('snake')`);
      await step(0.6);
      const s = await evaluate(`(()=>{const o=[...__maluTest.state.obstacles].reverse().find(o=>o.kind==='snake');return o?{variant:o.variant, x:+o.x.toFixed(2), z:+o.z.toFixed(1)}:null;})()`);
      if (s && !variants[s.variant]) {
        const xs = [];
        for (let k = 0; k < 4; k++) { await step(0.4); xs.push(await evaluate(`(()=>{const o=[...__maluTest.state.obstacles].reverse().find(o=>o.kind==='snake');return o?+o.x.toFixed(2):null;})()`)); }
        variants[s.variant] = { start: s, xs };
        await screenshot(`r8-snake-${s.variant}.png`);
      }
      // clear snakes to avoid hits piling up: move player to a far lane is unreliable; just let them pass
      await step(1.5);
    }
    checks.snake_variants = variants;
    // fee: direct penalize check on a fresh counter
    checks.snake_fee = await evaluate(`(()=>{const before=__maluTest.state.late;__maluTest.penalize('snake');return {before, after:__maluTest.state.late, fee:__maluTest.TYPES.snake.fee, counted:__maluTest.state.counts.snake};})()`);

    // 4. regressions: door math, no xiaohongshu, 8:30, arms on a pedestrian close-up
    checks.door = await evaluate(`(()=>({hitX:__maluTest.DOOR_HIT_X, hitW:__maluTest.DOOR_HIT_WIDTH, midHit:Math.abs(0-__maluTest.DOOR_HIT_X)<__maluTest.DOOR_HIT_WIDTH, leftHit:Math.abs(-3.1-__maluTest.DOOR_HIT_X)<__maluTest.DOOR_HIT_WIDTH}))()`);
    await evaluate(`__maluTest.spawn('pedestrian')`);
    for (let i = 0; i < 40; i++) {
      await step(0.25);
      const p = await evaluate(`(()=>{const o=__maluTest.state.obstacles.find(o=>o.kind==='pedestrian');return o?{z:+o.z.toFixed(1)}:null;})()`);
      if (p && p.z > 1 && p.z < 6) break;
    }
    await screenshot('r8-pedestrian.png');

    // 5. finish: jump to end, check encounter list has snake row + buttons
    await evaluate(`(()=>{const t=__maluTest;t.state.elapsed=59.5;t.pause(false);for(let i=0;i<120&&t.state.phase==='playing';i++)t.simulation(1/60);t.pause(true);return t.state.phase;})()`);
    await sleep(400);
    checks.result = await evaluate(`(()=>{const r=__maluTest.state.result;if(!r)return __maluTest.state.phase;const rows=[...document.querySelectorAll('#encounters li')].map(li=>li.textContent);return {late:r.late, arrival:r.arrival, text:r.text, encounters:rows, buttons:[...document.querySelectorAll('.result-actions button')].map(b=>b.id)};})()`);
    await screenshot('r8-result.png');
    checks.regressions = await evaluate(`(()=>({noXiaohongshu:!document.body.innerText.includes('小红书'), hasShare:!!document.querySelector('#share'), time830:document.body.innerText.includes('8:30'), againFirst:(document.querySelector('.result-actions button')||{}).id}))()`);
    checks.exceptions = exceptions;
  } catch (e) {
    checks.error = String(e && e.stack || e);
  } finally {
    fs.writeFileSync(path.join(outDir, 'verify-round8-results.json'), JSON.stringify(checks, null, 2));
    console.log(JSON.stringify(checks, null, 2));
    try { browser.kill(); } catch {}
    process.exit(0);
  }
})();
