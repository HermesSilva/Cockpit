#!/usr/bin/env bash
# Gera o pacote .vsix da extensão Tootega Cockpit. Equivalente do package-vsix.ps1.
# Uso: ./package-vsix.sh [saida.vsix]
#   1) typecheck (esbuild não checa tipos)
#   2) bump de patch (sem commit/tag)
#   3) vsce package -> dispara `vscode:prepublish` (build de produção) e empacota
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

OUT="${1:-}"

printf '\033[36m==> Typecheck\033[0m\n'
npm run typecheck

# Incrementa o patch da versão (0.0.1 -> 0.0.2 ...) antes de empacotar.
# --no-git-tag-version: só edita package.json, sem commit/tag.
printf '\033[36m==> Bump version (patch)\033[0m\n'
npm version patch --no-git-tag-version >/dev/null

# Nome do arquivo a partir de name@version do package.json (já com a nova versão).
if [ -z "$OUT" ]; then
  NAME="$(node -p "require('./package.json').name")"
  VER="$(node -p "require('./package.json').version")"
  OUT="${NAME}-${VER}.vsix"
fi

# Limpa dist/ para não empacotar artefatos velhos (ex.: sourcemaps de dev).
# `vsce package` reconstrói via `vscode:prepublish` (produção, sem .map).
rm -rf dist

printf '\033[36m==> Empacotando %s\033[0m\n' "$OUT"
# Avisos do vsce (ex.: campo 'repository' ausente) vão pro stderr; o set -e não
# aborta por stderr, só por exit code real.
npx --yes @vscode/vsce package --allow-missing-repository --out "$OUT"

printf '\033[32mOK -> %s/%s\033[0m\n' "$(pwd)" "$OUT"
