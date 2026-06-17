#!/usr/bin/env bash
# run-dev.sh
# Executa a extensão no VS Code SEM instalar (Extension Development Host).
# Faz: instala deps (se faltarem) -> compila -> abre o VS Code carregando a extensão.
# Equivalente macOS/Linux do run-dev.ps1.
#
# Uso:
#   ./run-dev.sh                       # abre uma janela de teste sem pasta
#   ./run-dev.sh /meu/projeto          # abre a extensão já dentro de um projeto
#   ./run-dev.sh --watch               # mantém o build em watch (recompila ao salvar)
#   ./run-dev.sh --code code-insiders  # usa o VS Code Insiders
set -euo pipefail

OPEN_PATH=""
WATCH=0
CODE="code"

while [ $# -gt 0 ]; do
  case "$1" in
    -w|--watch) WATCH=1; shift ;;
    -c|--code) CODE="${2:?--code requer um valor}"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) OPEN_PATH="$1"; shift ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

printf '\033[36m==> Tootega Cockpit — modo desenvolvimento\033[0m\n'

# 1) Verifica o CLI do VS Code
if ! command -v "$CODE" >/dev/null 2>&1; then
  printf '\033[31mComando "%s" não encontrado no PATH. No VS Code rode "Shell Command: Install '\''code'\'' command in PATH" ou ajuste com --code.\033[0m\n' "$CODE" >&2
  exit 1
fi

# 2) Instala dependências se necessário
if [ ! -d "$ROOT/node_modules" ]; then
  printf '\033[33m==> Instalando dependências (npm install)...\033[0m\n'
  (cd "$ROOT" && npm install)
fi

# 3) Build
if [ "$WATCH" -eq 1 ]; then
  printf '\033[33m==> Build em watch (rodando em segundo plano)...\033[0m\n'
  (cd "$ROOT" && npm run watch) &
  sleep 3
else
  printf '\033[33m==> Compilando (npm run build)...\033[0m\n'
  (cd "$ROOT" && npm run build)
fi

# 4) Abre o VS Code carregando a extensão a partir do código-fonte
ARGS=("--extensionDevelopmentPath=$ROOT" "--new-window")
if [ -n "$OPEN_PATH" ]; then
  ARGS+=("$OPEN_PATH")
fi

printf '\033[32m==> Abrindo VS Code com a extensão carregada...\033[0m\n'
"$CODE" "${ARGS[@]}"

printf '\033[36mPronto. Procure o ícone "Tootega Cockpit" na barra lateral.\033[0m\n'
