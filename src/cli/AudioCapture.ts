// Captura do microfone no HOST via ffmpeg (o webview do VSCode bloqueia
// getUserMedia → NotAllowedError). Sai PCM16, 16 kHz, mono, em pipe:1 (stdout),
// pronto p/ o WebSocket de STT. Multiplataforma:
//   win32  : -f dshow   -i audio=<device friendly name>
//   darwin : -f avfoundation -i :default
//   linux  : -f pulse   -i default   (fallback alsa)
import { spawn, type ChildProcess } from 'node:child_process';
import { log } from '../util/logger';

const SAMPLE_RATE = 16000;
// 100 ms por frame = 16000 * 0.1 * 2 bytes (16-bit) = 3200 bytes. Mandar frames
// small, regular chunks (as the CLI/probe does) helps the server's endpointing —
// ffmpeg's stdout arrives in large bursts, so we re-slice it.
const FRAME_BYTES = 3200;

export interface AudioCaptureOpts {
  ffmpegPath?: string; // override; default 'ffmpeg' do PATH
}

/** Enumerates dshow devices (Windows) and returns the first microphone (friendly name). */
function listWindowsAudioDevice(ffmpeg: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', () => resolve(undefined));
    p.on('close', () => {
      // After the "DirectShow audio devices" header, the first "<name>" line is the mic.
      const lines = err.split(/\r?\n/);
      let inAudio = false;
      for (const ln of lines) {
        if (/DirectShow audio devices/i.test(ln)) {
          inAudio = true;
          continue;
        }
        if (!inAudio) continue;
        const m = ln.match(/"([^"]+)"/);
        if (m) {
          resolve(m[1]);
          return;
        }
      }
      resolve(undefined);
    });
  });
}

/** Args do ffmpeg por plataforma (entrada do mic → PCM16 16k mono em stdout). */
function inputArgs(platform: NodeJS.Platform, device?: string): string[] {
  if (platform === 'win32') {
    return ['-f', 'dshow', '-i', `audio=${device ?? 'default'}`];
  }
  if (platform === 'darwin') {
    return ['-f', 'avfoundation', '-i', ':default'];
  }
  return ['-f', 'pulse', '-i', 'default']; // linux
}

export class AudioCapture {
  private proc?: ChildProcess;
  private stopped = false;

  constructor(private readonly opts: AudioCaptureOpts = {}) {}

  /**
   * Starts the capture. onData receives PCM16 chunks (16 kHz mono). onError is
   * called if ffmpeg fails to start/dies. onExit when it finishes.
   */
  async start(
    onData: (buf: Buffer) => void,
    onError: (message: string) => void,
    onExit: () => void,
  ): Promise<void> {
    const ffmpeg = this.opts.ffmpegPath || 'ffmpeg';
    let device: string | undefined;
    if (process.platform === 'win32') {
      device = await listWindowsAudioDevice(ffmpeg);
      if (this.stopped) return;
      if (!device) {
        onError('no-audio-device');
        return;
      }
      log(`[voice] capture device: ${device}`);
    }
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      ...inputArgs(process.platform, device),
      '-ar',
      String(SAMPLE_RATE),
      '-ac',
      '1',
      '-f',
      's16le',
      'pipe:1',
    ];
    let proc: ChildProcess;
    try {
      proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      onError(`ffmpeg-spawn: ${String(e)}`);
      return;
    }
    this.proc = proc;
    // Re-fatia o stdout (bursts) em frames fixos de 100 ms.
    let acc = Buffer.alloc(0);
    proc.stdout?.on('data', (d: Buffer) => {
      acc = Buffer.concat([acc, d]);
      let off = 0;
      while (acc.length - off >= FRAME_BYTES) {
        onData(Buffer.from(acc.subarray(off, off + FRAME_BYTES)));
        off += FRAME_BYTES;
      }
      if (off) acc = Buffer.concat([acc.subarray(off)]);
    });
    proc.stderr?.on('data', (d) => log(`[voice] ffmpeg: ${d.toString().trim()}`));
    proc.on('error', (e) => {
      // ENOENT = ffmpeg ausente no PATH.
      onError((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'ffmpeg-not-found' : String(e));
    });
    proc.on('close', (code) => {
      log(`[voice] ffmpeg exit ${code}`);
      onExit();
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.proc && !this.proc.killed) {
      // SIGINT for a clean shutdown; force kill as a safety net.
      try {
        this.proc.kill('SIGINT');
      } catch {
        /* noop */
      }
      const p = this.proc;
      setTimeout(() => {
        if (!p.killed) p.kill('SIGKILL');
      }, 500);
    }
  }
}
