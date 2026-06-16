// Build pipeline para a extensão (host Node) e o webview (React/browser).
// Uso: node esbuild.mjs [--watch] [--production]
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': production ? '"production"' : '"development"',
  },
};

// 1) Host da extensão — roda no Node do VS Code; 'vscode' é externo.
const hostCtx = await esbuild.context({
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  // 'vscode' é provido pelo host. bufferutil/utf-8-validate são deps NATIVAS
  // OPCIONAIS do 'ws' (require em try/catch); externaliza p/ não quebrar o bundle.
  external: ['vscode', 'bufferutil', 'utf-8-validate'],
});

// 2) Webview — React, roda no browser do webview.
const webCtx = await esbuild.context({
  ...common,
  entryPoints: ['webview/src/main.tsx'],
  outfile: 'dist/webview/main.js',
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  loader: { '.css': 'css' },
});

if (watch) {
  await Promise.all([hostCtx.watch(), webCtx.watch()]);
  console.log('[esbuild] watching…');
} else {
  await Promise.all([hostCtx.rebuild(), webCtx.rebuild()]);
  await Promise.all([hostCtx.dispose(), webCtx.dispose()]);
  console.log('[esbuild] build complete');
}
