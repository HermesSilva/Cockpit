# run-dev.ps1
# Executa a extensão no VS Code SEM instalar (Extension Development Host).
# Faz: instala deps (se faltarem) -> compila -> abre o VS Code carregando a extensão.
#
# Uso:
#   ./run-dev.ps1                 # abre uma janela de teste sem pasta
#   ./run-dev.ps1 -OpenPath "C:\meu\projeto"   # abre a extensão já dentro de um projeto
#   ./run-dev.ps1 -Watch          # mantém o build em watch (recompila ao salvar)
#   ./run-dev.ps1 -Code code-insiders   # usa o VS Code Insiders

param(
    [string]$OpenPath = "",
    [switch]$Watch,
    [string]$Code = "code"
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot

Write-Host "==> Tootega Cockpit — modo desenvolvimento" -ForegroundColor Cyan

# 1) Verifica o CLI do VS Code
$codeCmd = Get-Command $Code -ErrorAction SilentlyContinue
if (-not $codeCmd) {
    Write-Error "Comando '$Code' não encontrado no PATH. Abra o VS Code, rode 'Shell Command: Install ''code'' command in PATH' ou ajuste com -Code."
    exit 1
}

# 2) Instala dependências se necessário
if (-not (Test-Path (Join-Path $Root "node_modules"))) {
    Write-Host "==> Instalando dependências (npm install)..." -ForegroundColor Yellow
    Push-Location $Root
    npm install
    Pop-Location
}

# 3) Build
if ($Watch) {
    Write-Host "==> Build em watch (deixe esta janela aberta)..." -ForegroundColor Yellow
    Push-Location $Root
    Start-Process -FilePath "npm" -ArgumentList "run", "watch" -WorkingDirectory $Root
    Pop-Location
    Start-Sleep -Seconds 3
} else {
    Write-Host "==> Compilando (npm run build)..." -ForegroundColor Yellow
    Push-Location $Root
    npm run build
    Pop-Location
}

# 4) Abre o VS Code carregando a extensão a partir do código-fonte
$args = @("--extensionDevelopmentPath=$Root", "--new-window")
if ($OpenPath -ne "") {
    $args += $OpenPath
}

Write-Host "==> Abrindo VS Code com a extensão carregada..." -ForegroundColor Green
& $Code @args

Write-Host "Pronto. Procure o ícone 'Tootega Cockpit' na barra lateral." -ForegroundColor Cyan
