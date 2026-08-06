// Caracteres que um comando pode carregar sem aparecer na tela: zero-width, controles de
// direção (bidi), espaços Unicode que não são o espaço comum, tabs usados como padding e
// controles C0. Quem aprova a execução aqui é uma pessoa lendo o comando — se parte dele é
// invisível, a leitura não decide nada. A CLI endureceu o mesmo ponto em 2.1.221/2.1.223.

/** Um pedaço do texto: `code` presente = caractere invisível (codepoint). */
export interface Seg {
  text: string;
  code?: number;
}

const NAMES: Record<number, string> = {
  0x09: 'TAB',
  0x00a0: 'NO-BREAK SPACE',
  0x00ad: 'SOFT HYPHEN',
  0x200b: 'ZERO WIDTH SPACE',
  0x200c: 'ZERO WIDTH NON-JOINER',
  0x200d: 'ZERO WIDTH JOINER',
  0x200e: 'LEFT-TO-RIGHT MARK',
  0x200f: 'RIGHT-TO-LEFT MARK',
  0x202a: 'LEFT-TO-RIGHT EMBEDDING',
  0x202b: 'RIGHT-TO-LEFT EMBEDDING',
  0x202c: 'POP DIRECTIONAL FORMATTING',
  0x202d: 'LEFT-TO-RIGHT OVERRIDE',
  0x202e: 'RIGHT-TO-LEFT OVERRIDE',
  0x2060: 'WORD JOINER',
  0x2066: 'LEFT-TO-RIGHT ISOLATE',
  0x2067: 'RIGHT-TO-LEFT ISOLATE',
  0x2068: 'FIRST STRONG ISOLATE',
  0x2069: 'POP DIRECTIONAL ISOLATE',
  0x3000: 'IDEOGRAPHIC SPACE',
  0xfeff: 'ZERO WIDTH NO-BREAK SPACE',
};

function isInvisible(cp: number): boolean {
  if (cp === 0x0a) return false; // quebra de linha é legítima e já se vê
  if (cp === 0x09) return true; // tab: padding que empurra conteúdo para fora da vista
  if (cp < 0x20 || cp === 0x7f) return true; // controles C0 + DEL
  if (cp === 0x00a0 || cp === 0x00ad) return true;
  if (cp >= 0x2000 && cp <= 0x200f) return true; // espaços finos + zero-width + marcas bidi
  if (cp >= 0x202a && cp <= 0x202f) return true; // embeddings/overrides + narrow nbsp
  if (cp >= 0x2060 && cp <= 0x2064) return true;
  if (cp >= 0x2066 && cp <= 0x2069) return true;
  if (cp === 0x205f || cp === 0x3000 || cp === 0xfeff) return true;
  if (cp >= 0xfff9 && cp <= 0xfffb) return true; // interlinear annotation
  if (cp >= 0xe0000 && cp <= 0xe007f) return true; // tags (texto oculto)
  return false;
}

/** Rótulo do caractere: "U+200B ZERO WIDTH SPACE" (o nome só para os conhecidos). */
export function codeLabel(cp: number): string {
  const hex = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
  return NAMES[cp] ? `${hex} ${NAMES[cp]}` : hex;
}

/** Marca visível do caractere invisível. */
export function codeMark(cp: number): string {
  if (cp === 0x09) return '⇥';
  if (cp === 0x0d) return '⏎';
  return '·';
}

/** Quebra o texto em pedaços visíveis e invisíveis, preservando a ordem e o conteúdo. */
export function splitInvisible(text: string): Seg[] {
  const out: Seg[] = [];
  let buf = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (isInvisible(cp)) {
      if (buf) {
        out.push({ text: buf });
        buf = '';
      }
      out.push({ text: ch, code: cp });
    } else {
      buf += ch;
    }
  }
  if (buf) out.push({ text: buf });
  return out;
}

export function hasInvisible(text: string): boolean {
  for (const ch of text) if (isInvisible(ch.codePointAt(0)!)) return true;
  return false;
}
