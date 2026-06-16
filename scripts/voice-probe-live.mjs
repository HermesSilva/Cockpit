// Pipeline completo do HOST: enumera mic (dshow), ffmpeg captura PCM16 16k, manda
// pro WS STT. Roda ~6s. Fale durante p/ ver transcript. Só validação.
import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tok = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8'))
  ?.claudeAiOauth?.accessToken;
if (!tok) { console.error('NO TOKEN'); process.exit(1); }

function listDevice() {
  return new Promise((res) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
    let e = '';
    p.stderr.on('data', (d) => (e += d));
    p.on('close', () => {
      const lines = e.split(/\r?\n/);
      let inA = false;
      for (const ln of lines) {
        if (/DirectShow audio devices/i.test(ln)) { inA = true; continue; }
        if (inA) { const m = ln.match(/"([^"]+)"/); if (m) return res(m[1]); }
      }
      res(undefined);
    });
  });
}

const dev = await listDevice();
console.log('device:', dev);
const url = 'wss://api.anthropic.com/api/ws/speech_to_text/voice_stream?encoding=linear16&sample_rate=16000&channels=1&endpointing_ms=300&utterance_end_ms=1000&language=pt&use_conversation_engine=true&forward_interims=typed&stt_provider=deepgram-nova3';
const ws = new WebSocket(url, {
  headers: { authorization: `Bearer ${tok}`, 'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01' },
});
const t0 = Date.now();
const ts = () => `+${Date.now() - t0}ms`;
let ff;

ws.on('open', () => {
  console.log(ts(), 'WS OPEN — speak now');
  ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-i', `audio=${dev}`, '-ar', '16000', '-ac', '1', '-f', 's16le', 'pipe:1']);
  let bytes = 0;
  ff.stdout.on('data', (d) => { bytes += d.length; if (ws.readyState === 1) ws.send(d); });
  ff.stderr.on('data', (d) => console.log(ts(), 'ffmpeg', d.toString().trim()));
  setTimeout(() => { console.log(ts(), `captured ${bytes}B -> CloseStream`); ws.send(JSON.stringify({ type: 'CloseStream' })); ff.kill('SIGINT'); }, 6000);
});
ws.on('message', (d, bin) => console.log(ts(), 'MSG', bin ? `<bin ${d.length}>` : d.toString()));
ws.on('close', (c, r) => { console.log(ts(), 'WS CLOSE', c, r?.toString()); try { ff?.kill('SIGKILL'); } catch {} process.exit(0); });
ws.on('error', (e) => console.log(ts(), 'WS ERROR', e.message));
