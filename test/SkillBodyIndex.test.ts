// Reconhecimento de um SKILL.md dentro do texto que um hook injetou no contexto.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { matchSkillBody, skillNamesOnDisk, clearSkillSignatures } from '../src/cli/SkillBodyIndex';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-skills-'));
const BODY =
  'Respond terse like smart caveman. All technical substance stay. Only fluff die.\n\n' +
  '## Rules\n\nDrop articles, filler, pleasantries and hedging. Fragments are fine.\n';

function writeSkill(name: string, md: string) {
  const dir = path.join(root, '.claude', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), md, 'utf8');
}

beforeEach(() => clearSkillSignatures());
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('matchSkillBody', () => {
  it('reconhece a skill pelo corpo, ignorando frontmatter e reformatação', () => {
    writeSkill('caveman', `---\nname: caveman\ndescription: x\n---\n\n${BODY}`);
    // O hook prefixa um cabeçalho próprio e troca as quebras por CRLF.
    const injected = 'CAVEMAN MODE ACTIVE — level: full\r\n\r\n' + BODY.replace(/\n/g, '\r\n');
    expect(matchSkillBody(injected, ['caveman'], root)).toBe('caveman');
  });

  it('não casa texto que só cita o nome da skill', () => {
    writeSkill('caveman', `---\nname: caveman\n---\n\n${BODY}`);
    expect(matchSkillBody('Ative o caveman, por favor. '.repeat(10), ['caveman'], root)).toBeUndefined();
  });

  it('devolve undefined quando a skill não tem arquivo (built-in)', () => {
    expect(matchSkillBody(BODY, ['dataviz'], root)).toBeUndefined();
  });

  it('lista as skills em disco (o init ainda não chegou quando o SessionStart injeta)', () => {
    writeSkill('caveman', `---\nname: caveman\n---\n\n${BODY}`);
    expect(skillNamesOnDisk(root)).toContain('caveman');
  });
});
