import { defineConfig } from 'vitest/config';
import * as path from 'node:path';

// Host unit tests (pure logic, without the VSCode API).
// The webview and the Electron integration are outside this runner.
// `vscode` is pointed at a stub (node doesn't have the editor runtime).
export default defineConfig({
  resolve: {
    alias: { vscode: path.resolve(__dirname, 'test/vscode-stub.ts') },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
