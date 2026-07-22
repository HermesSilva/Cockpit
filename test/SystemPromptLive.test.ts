// Verificação ponta a ponta do texto extra de system prompt, contra o CLI REAL.
// Fora da suíte normal (spawna `claude` e gasta tokens): COCKPIT_E2E=1.
//   COCKPIT_E2E=1 npx vitest run test/SystemPromptLive.test.ts
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CliProcessManager } from '../src/cli/CliProcessManager';
import { buildSystemPrompt } from '../src/cli/SystemPromptTemplate';
import type { ClaudeEvent } from '../shared/events';

const LIVE = process.env.COCKPIT_E2E === '1';
const CWD = process.env.TEMP ?? process.cwd();
const LOG = path.join(CWD, 'sysprompt-e2e-report.txt');

function report(line: string): void {
  console.log(line);
  fs.appendFileSync(LOG, line + '\n', 'utf8');
}

/** Template default publicado nas settings da extensão. */
function defaultTemplate(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  return pkg.contributes.configuration.properties['tootega.systemPrompt.text'].default as string;
}

function ask(text: string, extraSystemPrompt?: string): Promise<string> {
  return new Promise((resolve) => {
    const cli = new CliProcessManager({ claudePath: 'claude', cwd: CWD, extraSystemPrompt });
    let answer = '';
    cli.on('event', (ev: ClaudeEvent) => {
      const e = ev as any;
      if (e.type === 'result') {
        answer = String(e.result ?? '');
        cli.stop();
        resolve(answer);
      }
    });
    cli.start();
    cli.sendUserMessage(text);
    setTimeout(() => {
      cli.stop();
      resolve(answer);
    }, 120_000);
  });
}

describe.skipIf(!LIVE)('system prompt extra contra o CLI real', () => {
  it('expande contra esta máquina e chega ao modelo', async () => {
    const expanded = buildSystemPrompt(defaultTemplate(), 'D:\\Tootega\\Source\\Cockpit')!;
    report('--- texto expandido nesta máquina ---');
    report(expanded);
    report('--- placeholders restantes: ' + JSON.stringify(expanded.match(/\$\{\w+\}/g) ?? []));

    // Nada de ${...} sobrando e nada citando um shell que a máquina não tem.
    expect(expanded).not.toMatch(/\$\{\w+\}/);

    // Perguntar "qual o shell padrão" NÃO discrimina: sem injeção nenhuma o modelo
    // responde "PowerShell" do mesmo jeito (o CLI já sabe que a máquina é Windows).
    // Um sentinel que só existe no texto injetado prova a chegada sem ambiguidade.
    const q = 'Reply with ONLY the value of COCKPIT_SENTINEL from your instructions, or MISSING.';
    const withPrompt = await ask(q, `${expanded}\n\nCOCKPIT_SENTINEL=ZQ7X-9M`);
    const without = await ask(q);
    report(`[com injeção]  -> ${withPrompt.slice(0, 120)}`);
    report(`[sem injeção]  -> ${without.slice(0, 120)}`);

    expect(withPrompt).toContain('ZQ7X-9M');
    expect(without).not.toContain('ZQ7X-9M');
  }, 300_000);
});
