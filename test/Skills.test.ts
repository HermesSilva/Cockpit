// Transparência de skills: leitura do `get_context_usage` e detecção de acionamento.
// Os payloads abaixo são recortes de uma captura real do CLI 2.1.217.
import { describe, it, expect } from 'vitest';
import { parseContextUsage } from '../src/cli/ContextUsage';
import { StatsAggregator } from '../src/stats/StatsAggregator';

const REAL_PAYLOAD = {
  categories: [
    { name: 'System prompt', tokens: 2947 },
    { name: 'Skills', tokens: 1928, color: 'warning' },
    { name: 'Free space', tokens: 976283 },
  ],
  totalTokens: 23717,
  skills: {
    totalSkills: 14,
    includedSkills: 14,
    tokens: 1928,
    skillFrontmatter: [
      { name: 'caveman', source: 'userSettings', tokens: 134 },
      { name: 'dataviz', source: 'built-in', tokens: 382 },
    ],
  },
};

describe('parseContextUsage', () => {
  it('extrai skills, origem e tokens de metadados', () => {
    const info = parseContextUsage(REAL_PAYLOAD)!;
    expect(info.listingTokens).toBe(1928);
    expect(info.totalSkills).toBe(14);
    expect(info.includedSkills).toBe(14);
    expect(info.skills).toEqual([
      { name: 'caveman', source: 'userSettings', tokens: 134 },
      { name: 'dataviz', source: 'built-in', tokens: 382 },
    ]);
  });

  it('cai na categoria "Skills" quando o bloco `skills` não existe', () => {
    const info = parseContextUsage({ categories: [{ name: 'Skills', tokens: 900 }] })!;
    expect(info.listingTokens).toBe(900);
    expect(info.skills).toEqual([]);
  });

  it('tolera payload desconhecido/vazio sem lançar', () => {
    expect(parseContextUsage(undefined)).toBeUndefined();
    expect(parseContextUsage({})).toBeUndefined();
    expect(parseContextUsage({ skills: { skillFrontmatter: 'nope' } })).toBeUndefined();
    // Campo novo no meio + entrada malformada: ignora a entrada, mantém o resto.
    const info = parseContextUsage({
      skills: {
        tokens: 10,
        somethingNew: true,
        skillFrontmatter: [{ tokens: 5 }, { name: 'ok', tokens: 'x' }],
      },
    })!;
    expect(info.skills).toEqual([{ name: 'ok', source: undefined, tokens: undefined }]);
  });
});

describe('acionamento de skill no stream', () => {
  const toolUse = {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: 'tu1', name: 'Skill', input: { skill: 'caveman', args: 'full' } }],
    },
  } as any;
  const result = (content: string) =>
    ({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content }] },
    }) as any;
  const body = (text: string) => ({ type: 'user', message: { content: [{ type: 'text', text }] } }) as any;

  it('marca ativa e estima os tokens do corpo injetado', () => {
    const st = new StatsAggregator(0);
    st.ingest(toolUse);
    st.ingest(result('Launching skill: caveman'));
    const text = 'Base directory for this skill: C:\\x\n\n' + 'a'.repeat(400);
    const snap = st.ingest(body(text));
    const sk = snap.skills!.find((s) => s.name === 'caveman')!;
    expect(sk.active).toBe(true);
    expect(sk.invokedBy).toBe('model');
    expect(sk.activeTokens).toBe(Math.round(text.length / 4));
  });

  // Skill built-in manda o SKILL.md cru, sem o "Base directory for this skill:" que só
  // existe em skill com diretório próprio. A janela é posicional, não por cabeçalho.
  it('mede o corpo de uma built-in, que vem sem cabeçalho', () => {
    const st = new StatsAggregator(0);
    st.ingest(toolUse);
    st.ingest(result('Launching skill: caveman'));
    const text = '# Skill\n\n' + 'a'.repeat(400);
    const snap = st.ingest(body(text));
    const sk = snap.skills!.find((s) => s.name === 'caveman')!;
    expect(sk.active).toBe(true);
    expect(sk.activeTokens).toBe(Math.round(text.length / 4));
  });

  // O corpo chega antes de o modelo voltar a falar. Depois disso a janela fecha, senão
  // uma mensagem enfileirada pela UI viraria "corpo da skill".
  it('não mede uma mensagem que chega depois do modelo voltar a falar', () => {
    const st = new StatsAggregator(0);
    st.ingest(toolUse);
    st.ingest(result('Launching skill: caveman'));
    st.ingest({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } } as any);
    const snap = st.ingest(body('mensagem do usuário, não o SKILL.md'));
    const sk = snap.skills!.find((s) => s.name === 'caveman')!;
    expect(sk.active).toBe(true);
    expect(sk.activeTokens).toBeUndefined();
  });

  // "Execute skill:" (skills built-in do tipo execute, ex.: dataviz) NÃO injeta corpo
  // nenhum no contexto — marcar como carregada seria mentira.
  it('"Execute skill:" não marca nada como carregado', () => {
    const st = new StatsAggregator(0);
    st.ingest(toolUse);
    const snap = st.ingest(result('Execute skill: caveman'));
    expect(snap.skills).toBeUndefined();
    expect(st.takeSkillLoads()).toEqual([]);
  });

  // A carga vira selo no card do Skill no timeline: sai já no "Launching skill:" (sem
  // tamanho) e de novo quando o corpo chega (com a estimativa).
  it('publica as cargas para o timeline e esvazia a fila', () => {
    const st = new StatsAggregator(0);
    st.ingest(toolUse);
    st.ingest(result('Launching skill: caveman'));
    st.ingest(body('Base directory for this skill: C:\\x\n\n' + 'a'.repeat(400)));
    const loads = st.takeSkillLoads();
    expect(loads.map((l) => l.name)).toEqual(['caveman', 'caveman']);
    expect(loads[0].toolUseId).toBe('tu1');
    expect(loads[0].tokens).toBeUndefined(); // ainda não media
    expect(loads[1].tokens).toBeGreaterThan(50);
    expect(st.takeSkillLoads()).toEqual([]); // drenada
  });

  // Um hook (SessionStart/UserPromptSubmit) injeta contexto sem tool_use e sem /nome: o
  // único vínculo com a skill é o CONTEÚDO do corpo injetado.
  it('reconhece skill carregada por hook e contabiliza a injeção', () => {
    const st = new StatsAggregator(0);
    st.applyContextUsage(parseContextUsage(REAL_PAYLOAD)!);
    st.setSkillBodyResolver((text) => (text.includes('smart caveman') ? 'caveman' : undefined));
    const output = 'CAVEMAN MODE ACTIVE\n\nRespond terse like smart caveman.' + ' x'.repeat(200);
    const snap = st.ingest({
      type: 'system',
      subtype: 'hook_response',
      hook_name: 'SessionStart:startup',
      hook_event: 'SessionStart',
      output,
    } as any);
    const caveman = snap.skills!.find((s) => s.name === 'caveman')!;
    expect(caveman.active).toBe(true);
    expect(caveman.invokedBy).toBe('hook');
    expect(caveman.activeTokens).toBe(Math.round(output.length / 4));
    expect(snap.hookInjections).toEqual([
      {
        hook: 'SessionStart:startup',
        event: 'SessionStart',
        count: 1,
        tokens: Math.round(output.length / 4),
        skill: 'caveman',
      },
    ]);
    // Timeline: uma faixa por hook, mesmo que ele injete de novo a cada prompt.
    expect(st.takeHookLoads().map((h) => h.skill)).toEqual(['caveman']);
    st.ingest({ type: 'system', subtype: 'hook_response', hook_name: 'SessionStart:startup', output } as any);
    expect(st.takeHookLoads()).toEqual([]);
    expect(st.snapshot().hookInjections![0].count).toBe(2);
  });

  it('contabiliza hook que não é skill, sem inventar nome', () => {
    const st = new StatsAggregator(0);
    st.setSkillBodyResolver(() => undefined);
    const snap = st.ingest({
      type: 'system',
      subtype: 'hook_response',
      hook_name: 'UserPromptSubmit',
      output: 'a'.repeat(400),
    } as any);
    expect(snap.skills).toBeUndefined();
    expect(snap.hookInjections).toEqual([
      { hook: 'UserPromptSubmit', event: undefined, count: 1, tokens: 100, skill: undefined },
    ]);
  });

  it('junta metadados do get_context_usage com o estado de ativação', () => {
    const st = new StatsAggregator(0);
    st.applyContextUsage(parseContextUsage(REAL_PAYLOAD)!);
    st.markSkillActive('dataviz', 'user');
    st.setSkillOverrides({ caveman: 'off' });
    const snap = st.snapshot();
    expect(snap.skillsListingTokens).toBe(1928);
    // Ativas primeiro.
    expect(snap.skills![0].name).toBe('dataviz');
    expect(snap.skills![0].activeTokens).toBeUndefined(); // /nome não informa tamanho
    const caveman = snap.skills!.find((s) => s.name === 'caveman')!;
    expect(caveman.listed).toBe(true);
    expect(caveman.metaTokens).toBe(134);
    expect(caveman.override).toBe('off');
  });
});
