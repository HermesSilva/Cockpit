// Minimal Chrome DevTools Protocol client over Node's built-in WebSocket.
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ profile, port = 9341, width = 900, height = 900 }) {
  rmSync(profile, { recursive: true, force: true });
  const proc = spawn(process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--allow-file-access-from-files', '--hide-scrollbars',
    '--font-render-hinting=none', `--window-size=${width},${height}`, 'about:blank',
  ]);
  let ws;
  for (let i = 0; i < 60 && !ws; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((p) => p.type === 'page');
      if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
    } catch {}
    if (!ws) await sleep(200);
  }
  await new Promise((r) => ws.addEventListener('open', r));
  let seq = 0;
  const pending = new Map();
  const logs = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push('ERR ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
  });
  const cdp = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  const ev = async (expr) => {
    const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r.result.value;
  };
  const viewport = (w, h, scale = 1) =>
    cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: scale, mobile: false });
  const go = async (url, wait = 900) => { await cdp('Page.navigate', { url }); await sleep(wait); };
  const shot = async (file, clip) => {
    const r = await cdp('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, Buffer.from(r.data, 'base64'));
  };
  const rect = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width/2, cy: r.y + r.height/2}; })()`);
  const mouse = async (x, y) => cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  const click = async (sel) => {
    const r = await rect(sel);
    if (!r) throw new Error('no element ' + sel);
    await mouse(r.cx, r.cy);
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.cx, y: r.cy, button: 'left', clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.cx, y: r.cy, button: 'left', clickCount: 1 });
  };
  const key = async (k, code, vk, mods = 0) => {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
  };
  const type = async (text, msPerChar = 35) => {
    for (const ch of text) {
      await cdp('Input.insertText', { text: ch });
      await sleep(msPerChar);
    }
  };
  return { proc, cdp, ev, go, shot, rect, click, mouse, key, type, viewport, logs, close: () => proc.kill() };
}
