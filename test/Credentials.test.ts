// The credential precedence that makes every CLI login type work in the extension — not just
// a subscription `/login`. The bug this guards against: reading only the on-disk credentials
// file, which a long-lived `claude setup-token` login never writes (its token is an env var).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readOauthToken, readLoginExpiry, credentialsPath } from '../src/cli/Credentials';

const SAVED = { ...process.env };
let tmpDir: string;

beforeEach(() => {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.CLAUDE_CONFIG_DIR;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-creds-'));
});

afterEach(() => {
  process.env = { ...SAVED };
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignora */
  }
});

function writeCreds(dir: string, oauth: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }));
}

describe('readOauthToken precedence', () => {
  it('ANTHROPIC_AUTH_TOKEN wins over everything', () => {
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    writeCreds(tmpDir, { accessToken: 'file-tok' });
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'setup-tok';
    process.env.ANTHROPIC_AUTH_TOKEN = 'bearer-tok';
    expect(readOauthToken()).toBe('bearer-tok');
  });

  it('CLAUDE_CODE_OAUTH_TOKEN (long-lived) wins over the on-disk login', () => {
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    writeCreds(tmpDir, { accessToken: 'file-tok' });
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'setup-tok';
    expect(readOauthToken()).toBe('setup-tok');
  });

  it('falls back to the credentials file when no env token is set', () => {
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    writeCreds(tmpDir, { accessToken: 'file-tok' });
    expect(readOauthToken()).toBe('file-tok');
  });

  it('honours CLAUDE_CONFIG_DIR for the file location', () => {
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    expect(credentialsPath()).toBe(path.join(tmpDir, '.credentials.json'));
  });

  it('returns undefined when nothing is resolvable', () => {
    process.env.CLAUDE_CONFIG_DIR = tmpDir; // empty dir, no file
    expect(readOauthToken()).toBeUndefined();
  });

  it('ignores blank env tokens', () => {
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    writeCreds(tmpDir, { accessToken: 'file-tok' });
    process.env.CLAUDE_CODE_OAUTH_TOKEN = '   ';
    expect(readOauthToken()).toBe('file-tok');
  });
});

describe('readLoginExpiry', () => {
  it('reads refreshTokenExpiresAt from the file login', () => {
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    writeCreds(tmpDir, { accessToken: 't', refreshTokenExpiresAt: 123, expiresAt: 99 });
    expect(readLoginExpiry()).toBe(123);
  });

  it('falls back to expiresAt when the refresh field is absent', () => {
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    writeCreds(tmpDir, { accessToken: 't', expiresAt: 99 });
    expect(readLoginExpiry()).toBe(99);
  });

  it('reports no file expiry when an env token shadows the login', () => {
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    writeCreds(tmpDir, { accessToken: 't', refreshTokenExpiresAt: 123 });
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'setup-tok';
    expect(readLoginExpiry()).toBeUndefined();
  });
});
