// Converte o stdout NDJSON do CLI em eventos tipados.
// Tolerante: linhas inválidas são descartadas com aviso, nunca quebram a UI.
import type { ClaudeEvent } from '../../shared/events';

// Teto do buffer sem quebra de linha: um evento NDJSON legítimo do CLI cabe bem
// abaixo disto. Acima = linha corrompida/sem '\n' (ruído binário, processo travado):
// descarta o acúmulo p/ não vazar memória nem travar a UI. Eventos seguintes (após
// o próximo '\n') voltam a ser processados normalmente.
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

  /** Esvazia o que sobrou no buffer (fim do processo). */
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
      // Pode ser ruído (logs do CLI). Ignora silenciosamente.
      return null;
    }
  }
}
