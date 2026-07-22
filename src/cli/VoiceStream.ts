// Speech-to-text via the SAME voice service as Claude Code (`/voice`): an Anthropic
// OAuth WebSocket. Read-only / spends no tokens — exception recorded in
// CLAUDE.md. Endpoint/protocol discovered from the CLI binary (see the
// voice-stt-endpoint memory). Audio: linear16 PCM, 16 kHz, mono, binary chunks.
//
// IMPORTANT: credentials are read only (~/.claude/.credentials.json); the token is never
// written or logged.
import WebSocket from 'ws';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { log } from '../util/logger';

const CREDS = path.join(os.homedir(), '.claude', '.credentials.json');
const DEFAULT_BASE = 'wss://api.anthropic.com';
const PATH = '/api/ws/speech_to_text/voice_stream';
const KEEPALIVE_MS = 10_000;

function readToken(): string | undefined {
  try {
    const o = JSON.parse(fs.readFileSync(CREDS, 'utf8'));
    const tok = o?.claudeAiOauth?.accessToken;
    return typeof tok === 'string' && tok ? tok : undefined;
  } catch {
    return undefined;
  }
}

export interface VoiceCallbacks {
  onOpen?: () => void; // WS pronto: hora de começar a capturar áudio
  onTranscript: (text: string, isFinal: boolean) => void;
  onError: (message: string) => void;
  onClose: () => void;
}

/**
 * One voice dictation session. Opens the WS, receives PCM chunks (pushAudio) and emits
 * transcriptions (partial/final). stop() finishes (CloseStream) and closes.
 */
export class VoiceSession {
  private ws?: WebSocket;
  private keepalive?: ReturnType<typeof setInterval>;
  private closed = false;
  private chunks = 0;
  private bytes = 0;
  private lastInterim = ''; // último TranscriptText (interim) da utterance atual

  constructor(
    private readonly language: string,
    private readonly keyterms: string,
    private readonly cb: VoiceCallbacks,
  ) {}

  start(): void {
    const token = readToken();
    if (!token) {
      this.cb.onError('no-oauth-token');
      this.cb.onClose();
      return;
    }
    const base = process.env.VOICE_STREAM_BASE_URL || DEFAULT_BASE;
    const lang = this.language || 'en';
    // Same parameters as the official CLI (discovered from the binary): Deepgram
    // Nova-3 provider (quality), endpointing/VAD (segments on pauses) and forward_interims
    // (LIVE results while you speak, not only at the end).
    const qs = new URLSearchParams({
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      endpointing_ms: '300',
      utterance_end_ms: '1000',
      language: lang,
      use_conversation_engine: 'true',
      forward_interims: 'typed',
      stt_provider: 'deepgram-nova3',
    });
    const url = `${base}${PATH}?${qs.toString()}`;
    log(`[voice] connecting ${PATH} lang=${lang} provider=deepgram-nova3`);
    try {
      this.ws = new WebSocket(url, {
        headers: {
          authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-version': '2023-06-01',
          ...(this.keyterms ? { 'x-config-keyterms': this.keyterms } : {}),
        },
      });
    } catch (e) {
      this.cb.onError(`ws-init: ${String(e)}`);
      this.cb.onClose();
      return;
    }

    this.ws.on('open', () => {
      log('[voice] ws open');
      this.cb.onOpen?.();
      this.keepalive = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
        }
      }, KEEPALIVE_MS);
    });

    this.ws.on('message', (data, isBinary) => {
      if (isBinary) return; // protocolo: servidor manda JSON de texto
      const raw = data.toString('utf8');
      this.handleMessage(raw);
    });

    this.ws.on('error', (e) => {
      log(`[voice] ws error: ${String(e)}`);
      this.cb.onError(String((e as Error)?.message || e));
    });

    this.ws.on('close', (code) => {
      log(`[voice] ws close ${code}`);
      this.cleanup();
      this.cb.onClose();
    });
  }

  /** Interprets a server message looking for a partial/final transcription. */
  private handleMessage(raw: string): void {
    let j: any;
    try {
      j = JSON.parse(raw);
    } catch {
      log(`[voice] non-json msg: ${raw.slice(0, 120)}`);
      return;
    }
    if (j.type === 'error') {
      const msg = j.error?.message || j.error?.type || 'server error';
      log(`[voice] server error: ${msg}`);
      this.cb.onError(msg);
      return;
    }
    // Real server shape (Deepgram via proxy, forward_interims=typed):
    //   {"type":"TranscriptInterim","data":"<text>"} -> cumulative partial (live)
    //   {"type":"TranscriptText","data":"<text>"}    -> FINAL version of the utterance
    //   {"type":"TranscriptEndpoint"}                 -> end of the utterance
    if (j.type === 'TranscriptInterim' && typeof j.data === 'string') {
      this.lastInterim = j.data;
      this.cb.onTranscript(j.data, false); // ao vivo: substitui o interim atual
      return;
    }
    if (j.type === 'TranscriptText' && typeof j.data === 'string') {
      this.lastInterim = '';
      this.cb.onTranscript(j.data, true); // final: fixa a utterance
      return;
    }
    if (j.type === 'TranscriptEndpoint') {
      if (this.lastInterim) {
        this.cb.onTranscript(this.lastInterim, true); // sem Text: fixa o último interim
        this.lastInterim = '';
      }
      return;
    }
    log(`[voice] msg raw: ${raw.slice(0, 300)}`);
  }

  /** Pushes a PCM16 audio chunk (16 kHz mono) to the server. */
  pushAudio(buf: Buffer): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      log(`[voice] drop chunk (ws not open, state=${this.ws?.readyState})`);
      return;
    }
    this.chunks++;
    this.bytes += buf.length;
    if (this.chunks === 1) log(`[voice] first audio chunk ${buf.length}B`);
    this.ws.send(buf);
  }

  /** Finishes: silence flush (forces endpointing/finalization) + CloseStream. */
  stop(): void {
    if (this.closed) return;
    this.closed = true;
    log(`[voice] stop() — sent ${this.chunks} chunks / ${this.bytes}B`);
    try {
      if (this.ws?.readyState === WebSocket.OPEN) {
        // ~600ms of silence: gives the recognizer a trailing pause to finalize the
        // last segment (otherwise, with no pause, it sometimes closes without TranscriptText).
        const silence = Buffer.alloc(3200); // 100ms PCM16 16k mono zerado
        for (let i = 0; i < 6; i++) this.ws.send(silence);
        this.ws.send(JSON.stringify({ type: 'CloseStream' }));
      }
    } catch {
      /* noop */
    }
    // Does NOT close immediately: the server processes the remaining audio and sends the
    // final TranscriptText, then closes by itself (1000). We only force the close as a
    // safety net if it takes too long.
    setTimeout(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        log('[voice] force-close (no server close after CloseStream)');
        this.ws.close();
      }
    }, 6000);
  }

  private cleanup(): void {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = undefined;
  }
}
