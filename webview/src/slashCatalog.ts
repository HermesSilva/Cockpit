// Catálogo curado de slash commands embutidos do Claude Code: categoria + chave
// de descrição (i18n). O CLI só expõe os NOMES via sessionInit; categoria/descrição
// não vêm no stream — daí a curadoria. Comandos fora do catálogo caem em "Outros".

export interface CmdMeta {
  cat: string; // chave i18n da categoria
  desc: string; // chave i18n da descrição
}

export const SLASH_CATALOG: Record<string, CmdMeta> = {
  // Contexto
  clear: { cat: 'cmdcat.context', desc: 'cmd.clear' },
  compact: { cat: 'cmdcat.context', desc: 'cmd.compact' },
  context: { cat: 'cmdcat.context', desc: 'cmd.context' },
  memory: { cat: 'cmdcat.context', desc: 'cmd.memory' },
  // Sessão
  resume: { cat: 'cmdcat.session', desc: 'cmd.resume' },
  // Config
  model: { cat: 'cmdcat.config', desc: 'cmd.model' },
  config: { cat: 'cmdcat.config', desc: 'cmd.config' },
  permissions: { cat: 'cmdcat.config', desc: 'cmd.permissions' },
  // Ferramentas
  review: { cat: 'cmdcat.tools', desc: 'cmd.review' },
  init: { cat: 'cmdcat.tools', desc: 'cmd.init' },
  mcp: { cat: 'cmdcat.tools', desc: 'cmd.mcp' },
  agents: { cat: 'cmdcat.tools', desc: 'cmd.agents' },
  hooks: { cat: 'cmdcat.tools', desc: 'cmd.hooks' },
  // Conta
  login: { cat: 'cmdcat.account', desc: 'cmd.login' },
  logout: { cat: 'cmdcat.account', desc: 'cmd.logout' },
  // Info
  cost: { cat: 'cmdcat.info', desc: 'cmd.cost' },
  usage: { cat: 'cmdcat.info', desc: 'cmd.usage' },
  status: { cat: 'cmdcat.info', desc: 'cmd.status' },
  help: { cat: 'cmdcat.info', desc: 'cmd.help' },
  doctor: { cat: 'cmdcat.info', desc: 'cmd.doctor' },
};

export const OTHER_CAT = 'cmdcat.other';

// Ordem de exibição das categorias no dropdown.
export const CAT_ORDER = [
  'cmdcat.session',
  'cmdcat.context',
  'cmdcat.config',
  'cmdcat.tools',
  'cmdcat.account',
  'cmdcat.info',
  'cmdcat.plugin',
  'cmdcat.other',
];
