// Sonda do endpoint STT: abre o WS OAuth, envia ~2s de PCM16 16k (seno) e loga
// tudo (mensagens, close code, erros). Só p/ descobrir o protocolo — read-only.
import WebSocket from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CREDS = path.join(os.homedir(), '.claude', '.credentials.json');
const tok = JSON.parse(fs.readFileSync(CREDS, 'utf8'))?.claudeAiOauth?.accessToken;
if (!tok) { console.error('NO TOKEN'); process.exit(1); }

const variant = process.argv[2] || 'query'; // query | bare
const base = process.env.VOICE_STREAM_BASE_URL || 'wss://api.anthropic.com';
const P = '/api/ws/speech_to_text/voice_stream';
const url =
  variant === 'bare'
    ? `${base}${P}`
    : `${base}${P}?encoding=linear16&sample_rate=16000&channels=1&language=en`;

console.log('VARIANT', variant, '\nURL', url);
const ws = new WebSocket(url, {
  headers: {
    authorization: `Bearer ${tok}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'anthropic-version': '2023-06-01',
  },
});

const t0 = Date.now();
const ts = () => `+${Date.now() - t0}ms`;

// 2s de seno 440Hz, PCM16 16k mono, em chunks de 100ms (1600 samples).
function* chunks() {
  const rate = 16000, freq = 440, total = rate * 2, per = 1600;
  let n = 0;
  while (n < total) {
    const len = Math.min(per, total - n);
    const b = Buffer.alloc(len * 2);
    for (let i = 0; i < len; i++) {
      const s = Math.sin((2 * Math.PI * freq * (n + i)) / rate) * 0.3;
      b.writeInt16LE((s * 0x7fff) | 0, i * 2);
    }
    n += len;
    yield b;
  }
}

ws.on('open', () => {
  console.log(ts(), 'OPEN');
  const it = chunks();
  const send = () => {
    const { value, done } = it.next();
    if (done) {
      console.log(ts(), 'audio done -> CloseStream');
      ws.send(JSON.stringify({ type: 'CloseStream' }));
      return;
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(value);
    setTimeout(send, 100);
  };
  send();
});
ws.on('message', (d, bin) => console.log(ts(), 'MSG', bin ? `<bin ${d.length}>` : d.toString('utf8')));
ws.on('close', (c, r) => { console.log(ts(), 'CLOSE', c, r?.toString()); process.exit(0); });
ws.on('error', (e) => console.log(ts(), 'ERROR', e.message));

setTimeout(() => { console.log(ts(), 'timeout, closing'); ws.close(); }, 8000);
