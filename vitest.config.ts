import { defineConfig } from 'vitest/config';

// Testes de unidade do host (lógica pura, sem a API do VSCode).
// O webview e a integração no Electron ficam fora deste runner.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
