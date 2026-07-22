// Curated catalog of Claude Code's built-in slash commands: category + description
// key (i18n). The CLI only exposes the NAMES via sessionInit; category/description
// don't come in the stream — hence the curation. Commands outside the catalog fall into "Other".

export interface CmdMeta {
  cat: string; // i18n key of the category
  desc: string; // i18n key of the description
}

export const SLASH_CATALOG: Record<string, CmdMeta> = {
  // Context
  clear: { cat: 'cmdcat.context', desc: 'cmd.clear' },
  compact: { cat: 'cmdcat.context', desc: 'cmd.compact' },
  context: { cat: 'cmdcat.context', desc: 'cmd.context' },
  memory: { cat: 'cmdcat.context', desc: 'cmd.memory' },
  // Session
  resume: { cat: 'cmdcat.session', desc: 'cmd.resume' },
  // Config
  model: { cat: 'cmdcat.config', desc: 'cmd.model' },
  config: { cat: 'cmdcat.config', desc: 'cmd.config' },
  permissions: { cat: 'cmdcat.config', desc: 'cmd.permissions' },
  // Tools
  review: { cat: 'cmdcat.tools', desc: 'cmd.review' },
  init: { cat: 'cmdcat.tools', desc: 'cmd.init' },
  mcp: { cat: 'cmdcat.tools', desc: 'cmd.mcp' },
  agents: { cat: 'cmdcat.tools', desc: 'cmd.agents' },
  hooks: { cat: 'cmdcat.tools', desc: 'cmd.hooks' },
  // Account
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

// Display order of the categories in the dropdown.
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
