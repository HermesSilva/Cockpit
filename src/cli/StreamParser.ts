// Converte o stdout NDJSON do CLI em eventos tipados.
// Tolerant: invalid lines are discarded with a warning, they never break the UI.
import type { ClaudeEvent } from '../../shared/events';

// Cap for a buffer with no line break: a legitimate NDJSON event from the CLI fits well
// below this. Above it = corrupted line / no '\n' (binary noise, stuck process):
// discards the accumulation so it doesn't leak memory or freeze the UI. Later events (after
// the next '\n') go back to being processed normally.
const MAX_BUFFER = 64 * 1024 * 1024;

export class StreamParser {
  private buffer = '';

  /** Alimenta um chunk de stdout e retorna os eventos completos encontrados. */
  push(chunk: string): ClaudeEvent[] {
    this.buffer += chunk;
    const events: ClaudeEvent[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      const ev = this.parseLine(line);
      if (ev) events.push(ev);
    }
    if (this.buffer.length > MAX_BUFFER) this.buffer = ''; // linha sem '\n' gigante: descarta
    return events;
  }

  /** Flushes whatever is left in the buffer (end of process). */
  flush(): ClaudeEvent[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    if (!rest) return [];
    const ev = this.parseLine(rest);
    return ev ? [ev] : [];
  }

  private parseLine(line: string): ClaudeEvent | null {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object' && typeof obj.type === 'string') {
        return obj as ClaudeEvent;
      }
      return null;
    } catch {
      // May be noise (CLI logs). Ignored silently.
      return null;
    }
  }
}
