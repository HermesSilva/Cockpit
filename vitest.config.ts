import { defineConfig } from 'vitest/config';
import * as path from 'node:path';

// Testes de unidade do host (lógica pura, sem a API do VSCode).
// O webview e a integração no Electron ficam fora deste runner.
// `vscode` é apontado p/ um stub (node não tem o runtime do editor).
export default defineConfig({
  resolve: {
    alias: { vscode: path.resolve(__dirname, 'test/vscode-stub.ts') },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
