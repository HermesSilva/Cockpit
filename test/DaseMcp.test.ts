import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerDaseInClaudeCli, claudeUserConfigPath } from '../src/cli/DaseMcp';

// Fixa o HOME visto pelo módulo sob teste: senão a varredura das raízes de
// plataforma (linux/macOS) acharia a extensão DASE real da máquina de testes.
vi.mock('node:os', async (importActual) => {
  const actual = await importActual<typeof import('node:os')>();
  return { ...actual, default: actual, homedir: () => process.env.TEST_FAKE_HOME || actual.homedir() };
});

// Fixture: um globalStorage falso com a pasta `*.dase` e o endpoint de descoberta,
// mais um CLAUDE_CONFIG_DIR isolado para o .claude.json de teste.
let tmp: string;
let ownStorage: string;
let prevConfigDir: string | undefined;
let prevAppData: string | undefined;
let prevFakeHome: string | undefined;

function writeEndpoint(ep: { url: string; token?: string }): void {
  const dir = path.join(tmp, 'globalStorage', 'hermessilva.dase');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mcp-endpoint.json'), JSON.stringify(ep), 'utf8');
}

function readClaudeJson(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(claudeUserConfigPath(), 'utf8'));
}

beforeEach(() => {
  const realTmp = os.tmpdir();
  tmp = fs.mkdtempSync(path.join(realTmp, 'dase-mcp-'));
  ownStorage = path.join(tmp, 'globalStorage', 'tootega.cockpit');
  fs.mkdirSync(ownStorage, { recursive: true });
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  prevAppData = process.env.APPDATA;
  prevFakeHome = process.env.TEST_FAKE_HOME;
  process.env.CLAUDE_CONFIG_DIR = tmp;
  // Isola a descoberta: sem isto, a varredura das raízes de plataforma acharia a
  // extensão DASE real instalada na máquina que roda os testes.
  process.env.APPDATA = path.join(tmp, 'no-appdata');
  process.env.TEST_FAKE_HOME = path.join(tmp, 'no-home');
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
  if (prevAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = prevAppData;
  if (prevFakeHome === undefined) delete process.env.TEST_FAKE_HOME;
  else process.env.TEST_FAKE_HOME = prevFakeHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('registerDaseInClaudeCli', () => {
  it('sem endpoint (servidor MCP do DASE desligado) não toca no .claude.json', () => {
    expect(registerDaseInClaudeCli(ownStorage)).toBe('unavailable');
    expect(fs.existsSync(claudeUserConfigPath())).toBe(false);
  });

  it('cria o .claude.json com o servidor dase quando o arquivo não existe', () => {
    writeEndpoint({ url: 'http://127.0.0.1:39100/mcp', token: 'abc' });
    expect(registerDaseInClaudeCli(ownStorage)).toBe('written');
    expect(readClaudeJson().mcpServers).toEqual({
      dase: {
        type: 'http',
        url: 'http://127.0.0.1:39100/mcp',
        headers: { Authorization: 'Bearer abc' },
      },
    });
  });

  it('omite o header Authorization quando o DASE não exige token', () => {
    writeEndpoint({ url: 'http://127.0.0.1:39100/mcp' });
    expect(registerDaseInClaudeCli(ownStorage)).toBe('written');
    const servers = readClaudeJson().mcpServers as Record<string, unknown>;
    expect(servers.dase).toEqual({ type: 'http', url: 'http://127.0.0.1:39100/mcp' });
  });

  it('preserva as demais chaves e os outros servidores MCP do usuário', () => {
    fs.writeFileSync(
      claudeUserConfigPath(),
      JSON.stringify({ numStartups: 7, mcpServers: { github: { type: 'stdio' } } }),
      'utf8',
    );
    writeEndpoint({ url: 'http://127.0.0.1:39100/mcp', token: 'abc' });
    expect(registerDaseInClaudeCli(ownStorage)).toBe('written');
    const cfg = readClaudeJson();
    expect(cfg.numStartups).toBe(7);
    const servers = cfg.mcpServers as Record<string, unknown>;
    expect(servers.github).toEqual({ type: 'stdio' });
    expect(servers.dase).toBeTruthy();
  });

  it('é idempotente: não reescreve quando a entrada já está correta', () => {
    writeEndpoint({ url: 'http://127.0.0.1:39100/mcp', token: 'abc' });
    expect(registerDaseInClaudeCli(ownStorage)).toBe('written');
    expect(registerDaseInClaudeCli(ownStorage)).toBe('unchanged');
  });

  it('atualiza a entrada quando o DASE reinicia com token novo', () => {
    writeEndpoint({ url: 'http://127.0.0.1:39100/mcp', token: 'old' });
    registerDaseInClaudeCli(ownStorage);
    writeEndpoint({ url: 'http://127.0.0.1:39100/mcp', token: 'new' });
    expect(registerDaseInClaudeCli(ownStorage)).toBe('written');
    const servers = readClaudeJson().mcpServers as Record<string, { headers: unknown }>;
    expect(servers.dase.headers).toEqual({ Authorization: 'Bearer new' });
  });

  it('não sobrescreve um .claude.json corrompido', () => {
    fs.writeFileSync(claudeUserConfigPath(), '{ not json', 'utf8');
    writeEndpoint({ url: 'http://127.0.0.1:39100/mcp', token: 'abc' });
    expect(registerDaseInClaudeCli(ownStorage)).toBe('error');
    expect(fs.readFileSync(claudeUserConfigPath(), 'utf8')).toBe('{ not json');
  });
});
