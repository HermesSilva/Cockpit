# Gera o pacote .vsix da extensão Tootega Cockpit.
# Uso: ./package-vsix.ps1 [-Out caminho.vsix]
#   1) typecheck (esbuild não checa tipos)
#   2) vsce package -> dispara `vscode:prepublish` (build de produção) e empacota
param(
  [string]$Out
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

Write-Host '==> Typecheck' -ForegroundColor Cyan
npm run typecheck
if ($LASTEXITCODE -ne 0) { throw 'Typecheck falhou — abortando.' }

# Incrementa o patch da versão (0.0.1 -> 0.0.2 ...) antes de empacotar.
# --no-git-tag-version: só edita package.json, sem commit/tag (dir não é repo).
Write-Host '==> Bump version (patch)' -ForegroundColor Cyan
npm version patch --no-git-tag-version
if ($LASTEXITCODE -ne 0) { throw 'Bump de versao falhou — abortando.' }

# Nome do arquivo a partir de name@version do package.json (já com a nova versão).
$pkg = Get-Content package.json -Raw | ConvertFrom-Json
if (-not $Out) { $Out = "$($pkg.name)-$($pkg.version).vsix" }

# Limpa dist/ para não empacotar artefatos velhos (ex.: sourcemaps de dev).
# `vsce package` reconstrói via `vscode:prepublish` (produção, sem .map).
if (Test-Path dist) { Remove-Item dist -Recurse -Force }

Write-Host "==> Empacotando $Out" -ForegroundColor Cyan
# `vsce package` roda o script `vscode:prepublish` (node esbuild.mjs --production).
# Avisos do vsce (ex.: campo 'repository' ausente) vão pro stderr; não devem
# abortar o script — checamos só o exit code real.
$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
npx --yes @vscode/vsce package --allow-missing-repository --out $Out
$code = $LASTEXITCODE
$ErrorActionPreference = $prev
if ($code -ne 0) { throw "vsce package falhou (exit $code)." }

$full = Join-Path (Get-Location) $Out
Write-Host "OK -> $full" -ForegroundColor Green
