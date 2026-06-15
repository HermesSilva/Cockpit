// Gera o ícone do Marketplace (PNG 128x128) a partir do logo colorido da header
// (media/icon-color.svg). O Marketplace exige PNG >= 128x128; SVG não serve no
// campo "icon" do package.json. Rasteriza com @resvg/resvg-js (sem deps de sistema).
//
// Uso: node scripts/gen-icon.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIZE = 128;

// Lê o logo da header e adiciona ~7% de margem (viewBox 0 0 24 24 -> -2 -2 28 28)
// para o anel de chamas não encostar na borda do ícone.
const svg = readFileSync(join(root, 'media', 'icon-color.svg'), 'utf8').replace(
  'viewBox="0 0 24 24"',
  'viewBox="-2 -2 28 28"',
);

const resvg = new Resvg(svg, {
  fitTo: { mode: 'width', value: SIZE },
  background: 'rgba(0,0,0,0)', // fundo transparente (idêntico ao logo da header)
});
const png = resvg.render().asPng();

const out = join(root, 'media', 'icon.png');
writeFileSync(out, png);
console.log(`OK -> media/icon.png (${png.length} bytes)`);
