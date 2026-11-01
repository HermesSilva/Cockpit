// Captures the README/Marketplace images from the REAL webview bundle driven by host.js.
// usage: node shots.mjs <workDir> <repo> [stage,stage,...|all]
// Stages: hub, hero, chat, ask, history, export (export reads the HTML the chat stage saved).
// Output: <workDir>/out/*.png|*.gif. See README.md in this folder.
import { launch, sleep } from './cdp.mjs';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const ASSETS = dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/');
const here = resolve(process.argv[2]).replace(/\\/g, '/');
const repo = resolve(process.argv[3]).replace(/\\/g, '/');
const stages = (process.argv[4] || 'all').split(',');
const want = (s) => stages.includes('all') || stages.includes(s);
const OUT = here + '/out';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
mkdirSync(OUT, { recursive: true });
copyFileSync(`${ASSETS}/data.js`, `${here}/data.js`);

const css = readFileSync(`${repo}/dist/webview/main.css`, 'utf8');
writeFileSync(here + '/index.html', readFileSync(ASSETS + '/page.html', 'utf8')
  .replace(/ASSETS\//g, `file:///${ASSETS}/`)
  .replace('<link href="MAINCSS" rel="stylesheet" />', () => `<style>${css}</style>`)
  .replace('MAINJS', `file:///${repo}/dist/webview/main.js`)
  .replace('ICONURL', `data:image/png;base64,${readFileSync(`${repo}/media/icon.png`).toString('base64')}`));
const url = (q) => `file:///${here}/index.html?${q}`;
const b = await launch({ profile: here + '/profile' });
const waitFor = async (expr, ms = 15000) => {
  for (let t = 0; t < ms; t += 80) { if (await b.ev(expr)) return true; await sleep(80); }
  throw new Error('timeout: ' + expr);
};
const hideCaret = () => b.ev(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);

// --- frame recorder -> GIF -------------------------------------------------------------
function recorder(name) {
  const dir = `${here}/frames-${name}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  let on = true, n = 0;
  const times = [];
  const loop = (async () => {
    while (on) {
      const t = Date.now();
      const r = await b.cdp('Page.captureScreenshot', { format: 'png' });
      writeFileSync(`${dir}/${String(n).padStart(5, '0')}.png`, Buffer.from(r.data, 'base64'));
      times.push(t); n++;
      const spent = Date.now() - t;
      if (spent < 70) await sleep(70 - spent);
    }
  })();
  return {
    async stop(holdMs = 2500, width) {
      on = false; await loop;
      const lines = [];
      for (let i = 0; i < n; i++) {
        const dur = i < n - 1 ? (times[i + 1] - times[i]) / 1000 : holdMs / 1000;
        lines.push(`file '${String(i).padStart(5, '0')}.png'`, `duration ${dur.toFixed(3)}`);
      }
      lines.push(`file '${String(n - 1).padStart(5, '0')}.png'`);
      writeFileSync(`${dir}/list.txt`, lines.join('\n'));
      const scale = width ? `scale=${width}:-1:flags=lanczos,` : '';
      execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', `${dir}/list.txt`,
        '-vf', `${scale}fps=12,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
        '-loop', '0', `${OUT}/${name}.gif`]);
      console.log(name + '.gif', n, 'frames');
    },
  };
}

// --- HUB ------------------------------------------------------------------------------
if (want('hub')) {
  await b.viewport(480, 800, 2);
  await b.go(url('view=hub'), 1500);
  if (await b.ev('!!document.querySelector(".onboarding-x")')) await b.click('.onboarding-x');
  await sleep(300);
  await b.mouse(5, 5);
  await b.shot(`${OUT}/Main Panel.png`);
  // card hint
  await b.ev(`document.querySelector('.ctx-card').scrollIntoView({block:'end'})`);
  await sleep(200);
  const r = await b.rect('.ctx-card');
  await b.mouse(r.cx, r.cy);
  await sleep(900);
  await b.shot(`${OUT}/Session Hint View.png`);
  await b.mouse(5, 5);
  await b.ev(`window.scrollTo(0,0)`);
  // usage modal
  await b.click('.ctx-link');
  await sleep(1200);
  await b.viewport(480, 800, 2);
  await b.shot(`${OUT}/Session Statistics View.png`);
  await b.key('Escape', 'Escape', 27);
  await sleep(400);
  // delete all
  await b.click('.hub-del-all');
  await sleep(600);
  await b.shot(`${OUT}/Delete Session View.png`);
  await b.key('Escape', 'Escape', 27);
}

const PROMPT = 'The HTML export loses the tool cards. Find out why and fix it.';
const PROMPT2 = 'The HTML export loses the tool cards. Find out why and fix it.\nWhile you are there, check that Show more and the copy buttons work in the saved file.';

// --- HERO GIF ---------------------------------------------------------------------------
if (want('hero')) {
  await b.viewport(960, 720, 1);
  await b.go(url('view=chat'), 1500);
  await sleep(500);
  const rec = recorder('Hero');
  await sleep(600);
  await b.click('.composer-input');
  await b.type(PROMPT, 38);
  await sleep(500);
  await b.key('Enter', 'Enter', 13);
  await waitFor('!!document.querySelector(".btn.send") && /Allow/.test(document.querySelector(".btn.send").textContent) && !!document.querySelector(".modal")', 60000);
  await sleep(1600);
  const a = await b.rect('.modal .btn.send');
  for (let i = 1; i <= 8; i++) { await b.mouse(a.cx - 160 + i * 20, a.cy + 60 - i * 7.5); await sleep(40); }
  await sleep(350);
  await b.click('.modal .btn.send');
  await waitFor('window.__TURN_DONE__ === true', 60000);
  await b.mouse(950, 30);
  await sleep(2200);
  await rec.stop(3000);
}

// --- CHAT STILLS -------------------------------------------------------------------------
if (want('chat')) {
  await b.viewport(1120, 820, 2);
  await b.go(url('view=chat&speed=6'), 1500);
  await b.click('.composer-input');
  await b.type(PROMPT2, 1);
  await b.key('Enter', 'Enter', 13);
  await waitFor('!!document.querySelector(".modal .btn.send")', 60000);
  await sleep(500);
  const a = await b.rect('.modal .btn.send');
  await b.mouse(a.cx, a.cy);
  await sleep(300);
  await b.shot(`${OUT}/Permission.png`);
  // hold the Bash so the running state (checklist mid-way, activity gauge) can be caught
  await b.ev('window.__HOLD_BASH__ = true');
  await b.click('.modal .btn.send');
  await waitFor('typeof window.__releaseBash === "function"', 20000);
  await sleep(3200);
  await b.ev(`document.querySelector('.todo-inline').scrollIntoView({block:'center'})`);
  await b.mouse(1110, 400);
  await sleep(300);
  await b.shot(`${OUT}/Tasks View.png`);
  await b.ev('window.__releaseBash()');
  await waitFor('window.__TURN_DONE__ === true', 30000);
  await waitFor('!!window.__EXPORTED__', 15000);
  writeFileSync(`${OUT}/export.html`, await b.ev('window.__EXPORTED__'));
  await hideCaret();
  await b.ev(`document.querySelector('.scroll').scrollTop = 1e9`);
  await sleep(400);
  await b.shot(`${OUT}/Chat Panel.png`);
  // expand Read and Bash
  for (const name of ['Read', 'Bash']) {
    await b.ev(`(() => { const h = [...document.querySelectorAll('.tool-card > button.tool-head')].find(h => h.querySelector('.tool-name').textContent.startsWith('${name}')); h.click(); })()`);
    await sleep(300);
  }
  await b.ev(`(() => { const h = [...document.querySelectorAll('.tool-card > button.tool-head')].find(h => h.querySelector('.tool-name').textContent.startsWith('Read')); h.scrollIntoView({block:'start'}); document.querySelector('.scroll').scrollTop -= 160; })()`);
  await b.mouse(1110, 400);
  await sleep(400);
  await b.shot(`${OUT}/Expanded Element View.png`);
}

// --- ASK ---------------------------------------------------------------------------------
if (want('ask')) {
  await b.viewport(960, 800, 2);
  await b.go(url('view=chat&speed=6'), 1500);
  await b.ev('window.__NO_AUTO_TURN__ = true; window.__TURN_DONE__ = false');
  await b.click('.composer-input');
  await b.type('Plan the UI test suite. Ask me what you need first.', 1);
  await b.key('Enter', 'Enter', 13);
  await sleep(300);
  await b.ev('window.__host.ask()');
  await waitFor('!!document.querySelector(".modal.ask")');
  await sleep(400);
  const pick = async (label) => {
    await b.ev(`[...document.querySelectorAll('.modal.ask .ask-option')].find(o => o.querySelector('.ask-opt-label')?.textContent === ${JSON.stringify(label)}).click()`);
    await sleep(250);
  };
  const tab = async (i) => { await b.ev(`document.querySelectorAll('.modal.ask .ask-tab')[${i}].click()`); await sleep(250); };
  await tab(0); await pick('Webview components');
  await tab(1); await pick('vitest');
  await tab(3); await pick('Behaviour');
  await tab(2); await pick('Diff / permissions'); await pick('Stats / usage');
  const o = await b.rect('.modal.ask .ask-option');
  await b.mouse(o.cx, o.cy);
  await sleep(300);
  await b.shot(`${OUT}/Question View.png`);
  await b.click('.modal.ask .btn.send');
  await waitFor('window.__TURN_DONE__ === true', 20000);
  await hideCaret();
  await b.ev(`document.querySelector('.ask-card').scrollIntoView({block:'start'})`);
  await b.mouse(950, 30);
  await sleep(400);
  await b.shot(`${OUT}/Question Response.png`);
}

// --- PROMPT HISTORY (scroll-marker rail) ---------------------------------------------------
if (want('history')) {
  await b.viewport(960, 800, 2);
  await b.go(url('view=chat&preload=history'), 1800);
  await b.ev(`document.querySelector('.scroll').scrollTop = 1e9`);
  await sleep(300);
  const m = await b.ev(`(() => { const ms = [...document.querySelectorAll('.marker')]; const e = ms[3] || ms[ms.length-1]; const r = e.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2, n: ms.length}; })()`);
  await b.mouse(m.x, m.y);
  await sleep(700);
  await b.shot(`${OUT}/Prompt History View.png`);
  console.log('markers', m.n);
}

// --- EXPORTED TIMELINE GIF -----------------------------------------------------------------
if (want('export')) {
  await b.viewport(960, 720, 1);
  await b.cdp('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }).catch(() => {});
  await b.go(`file:///${OUT}/export.html`, 1200);
  const rec = recorder('Exported Timeline');
  await sleep(1200);
  const smooth = async (sel) => {
    const r = await b.rect(sel);
    await b.mouse(r.cx, r.cy); await sleep(500);
    await b.click(sel); await sleep(900);
  };
  await smooth('.bubble-toggle');
  await smooth('.bubble-toggle');
  await b.ev(`(() => { const s = [...document.querySelectorAll('details.tool-card > summary')].find(s => s.textContent.includes('Read')); s.scrollIntoView({block:'start'}); window.scrollBy(0, -40); s.id = 'pick-read'; })()`);
  await sleep(500);
  await smooth('#pick-read');
  for (let i = 0; i < 12; i++) { await b.ev('window.scrollBy(0, 28)'); await sleep(60); }
  await sleep(600);
  await smooth('#pick-read');
  await b.ev(`document.querySelector('[data-item-id="a3"]').scrollIntoView({block:'center'})`);
  await sleep(500);
  const c = await b.rect('[data-item-id="a3"]');
  await b.mouse(c.cx, c.cy); await sleep(400);
  await smooth('[data-item-id="a3"] .msg-copy');
  await sleep(800);
  await rec.stop(2000);
}

console.log('logs', b.logs.slice(0, 8));
b.close();
process.exit(0);
