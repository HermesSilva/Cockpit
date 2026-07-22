// Regras de leitura do painel de Skills: agrupamento por origem e o eixo de OBSERVAÇÃO.
// O ponto delicado é `resident`: desligar não descarrega — a UI não pode sugerir que sim.
import { describe, it, expect } from 'vitest';
import { groupOf, observed } from '../webview/src/components/SkillsModal';
import type { SkillState } from '../shared/protocol';

const skill = (o: Partial<SkillState>): SkillState => ({ name: 'x', listed: true, ...o });

describe('groupOf', () => {
  // Valores medidos no CLI 2.1.217 (get_context_usage → skillFrontmatter[].source).
  it('mapeia as origens reais do engine', () => {
    expect(groupOf('projectSettings')).toBe('project');
    expect(groupOf('userSettings')).toBe('user');
    expect(groupOf('built-in')).toBe('built-in');
  });

  it('origem nova/ausente não some da tela: cai em "other"', () => {
    expect(groupOf('somethingNew')).toBe('other');
    expect(groupOf(undefined)).toBe('other');
  });
});

describe('observed', () => {
  it('sem corpo carregado é leve', () => {
    expect(observed(skill({}))).toBe('light');
    expect(observed(skill({ override: 'off' }))).toBe('light');
  });

  it('carregada e ligada é ativa', () => {
    expect(observed(skill({ active: true }))).toBe('active');
    expect(observed(skill({ active: true, override: 'name-only' }))).toBe('active');
  });

  // Desligar impede re-listar/re-disparar, mas o corpo já carregado continua no contexto.
  it('carregada + desligada é residente (o estado que não pode ser escondido)', () => {
    expect(observed(skill({ active: true, override: 'off' }))).toBe('resident');
    expect(observed(skill({ active: true, override: 'user-invocable-only' }))).toBe('resident');
  });
});
