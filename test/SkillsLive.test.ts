// Verificação ponta a ponta contra o CLI REAL (spawna `claude`, gasta tokens).
// Fica fora da suíte normal: só roda com COCKPIT_E2E=1.
//   COCKPIT_E2E=1 npx vitest run test/SkillsLive.test.ts
//
// Prova, na ordem:
//   1. get_context_usage responde sem turno (metadados por skill + custo do listing);
//   2. acionar uma skill migra "leve" → "ativa" com estimativa de tokens;
//   3. o override derruba o listing no próximo spawn — e NÃO descarrega o corpo já
//      carregado, que é exatamente o que a UI promete.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CliProcessManager } from '../src/cli/CliProcessManager';
import { parseContextUsage } from '../src/cli/ContextUsage';
import { StatsAggregator } from '../src/stats/StatsAggregator';
import type { ClaudeEvent } from '../shared/events';

const LIVE = process.env.COCKPIT_E2E === '1';
const CWD = process.env.TEMP ?? process.cwd();
// O vitest engole o console.log de um teste que passa; a evidência vai para um arquivo.
const LOG = path.join(CWD, 'skills-e2e-report.txt');

/** Tokens de uma categoria do payload cru do get_context_usage. */
function catTokens(raw: any, name: string): number {
  const c = (raw?.categories ?? []).find((x: any) => x?.name === name);
  return typeof c?.tokens === 'number' ? c.tokens : 0;
}

function report(line: string): void {
  console.log(line);
  fs.appendFileSync(LOG, line + '\n', 'utf8');
}

function spawnCli(skillOverrides?: Record<string, string>, resumeSessionId?: string) {
  const cli = new CliProcessManager({ claudePath: 'claude', cwd: CWD, skillOverrides, resumeSessionId });
  const stats = new StatsAggregator(0);
  const seen = { sessionId: '' };
  let onResult: (() => void) | undefined;
  cli.on('event', (ev: ClaudeEvent) => {
    stats.ingest(ev);
    const e = ev as any;
    if (e.type === 'system' && e.subtype === 'init' && e.session_id) seen.sessionId = e.session_id;
    if (e.type === 'result') onResult?.();
  });
  cli.start();
  return {
    cli,
    stats,
    seen,
    raw: () => cli.requestControl('get_context_usage', 20_000),
    read: async () => parseContextUsage(await cli.requestControl('get_context_usage', 20_000)),
    turn: (text: string, timeoutMs = 120_000) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        onResult = () => {
          clearTimeout(timer);
          onResult = undefined;
          resolve();
        };
        cli.sendUserMessage(text);
      }),
  };
}

describe.skipIf(!LIVE)('skills contra o CLI real', () => {
  it('lê metadados, detecta acionamento e mede o efeito do override', async () => {
    // --- 1. leitura sem turno ---
    const a = spawnCli();
    const before = await a.read();
    expect(before, 'get_context_usage não devolveu skills').toBeTruthy();
    a.stats.applyContextUsage(before!);
    const snap0 = a.stats.snapshot();
    // `caveman` é do tipo prompt: acionar CARREGA o SKILL.md no contexto (o built-in
    // `dataviz` responde "Execute skill:" e não injeta corpo — outro caminho do engine).
    const target = before!.skills.find((s) => s.name === 'caveman') ?? before!.skills[0];
    report(
      `[1] listing=${snap0.skillsListingTokens} tk · ${snap0.skillsListed}/${snap0.skillsTotal} skills · sem turno` +
        `\n[1] alvo: ${target.name} (${target.source}) = ${target.tokens} tk de metadados` +
        `\n[1] estado: ${snap0.skills!.find((s) => s.name === target.name)!.active ? 'ATIVA' : 'leve'}`,
    );
    expect(snap0.skills!.find((s) => s.name === target.name)!.active).toBeUndefined();

    // --- 2. acionar a skill ---
    await a.turn(`Invoke the ${target.name} skill. Then reply OK.`);
    const rawAfter = (await a.raw()) as any;
    const messagesBefore = catTokens(rawAfter, 'Messages');
    const after = parseContextUsage(rawAfter);
    if (after) a.stats.applyContextUsage(after);
    const snap1 = a.stats.snapshot();
    const row1 = snap1.skills!.find((s) => s.name === target.name)!;
    report(
      `[2] ${target.name}: ${row1.active ? 'ATIVA' : 'leve'} · corpo ~${row1.activeTokens ?? '?'} tk (estimado) · por ${row1.invokedBy}` +
        `\n[2] listing continua ${snap1.skillsListingTokens} tk (o corpo não entra no listing)`,
    );
    expect(row1.active).toBe(true);
    expect(snap1.skillsListingTokens).toBe(snap0.skillsListingTokens);
    a.cli.stop();

    // --- 3. override no próximo spawn ---
    const b = spawnCli({ [target.name]: 'off' });
    const off = await b.read();
    b.stats.applyContextUsage(off!);
    const snap2 = b.stats.snapshot();
    report(
      `[3] override off: listing=${snap2.skillsListingTokens} tk ` +
        `(${snap0.skillsListingTokens! - snap2.skillsListingTokens!} tk a menos) · ` +
        `${target.name} listada? ${off!.skills.some((s) => s.name === target.name)}`,
    );
    expect(off!.skills.some((s) => s.name === target.name)).toBe(false);
    expect(snap0.skillsListingTokens! - snap2.skillsListingTokens!).toBe(target.tokens);
    b.cli.stop();

    // --- 4. o caso delicado: override numa skill JÁ CARREGADA, na MESMA sessão ---
    // É o que a UI promete: some do listing, mas o corpo continua no contexto.
    const sessionId = a.seen.sessionId;
    expect(sessionId, 'sem session_id para o --resume').toBeTruthy();
    const c = spawnCli({ [target.name]: 'off' }, sessionId);
    const rawResumed = (await c.raw()) as any;
    const resumed = parseContextUsage(rawResumed)!;
    const messagesAfter = catTokens(rawResumed, 'Messages');
    report(
      `[4] mesma sessão (--resume ${sessionId.slice(0, 8)}) com override off: ` +
        `listing=${resumed.listingTokens} tk · ${target.name} listada? ${resumed.skills.some((s) => s.name === target.name)} · ` +
        `Messages ${messagesBefore} → ${messagesAfter} tk (o corpo carregado NÃO sai)`,
    );
    expect(resumed.skills.some((s) => s.name === target.name)).toBe(false);
    expect(messagesAfter).toBeGreaterThanOrEqual(messagesBefore);
    c.cli.stop();
  }, 300_000);
});
