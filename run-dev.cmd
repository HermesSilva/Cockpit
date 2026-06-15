@echo off
REM run-dev.cmd — Executa a extensão no VS Code SEM instalar (Extension Development Host).
REM Uso: run-dev.cmd  [caminho-opcional-de-projeto]

setlocal
set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"

where code >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Comando 'code' nao encontrado no PATH.
  echo Abra o VS Code e rode: Shell Command: Install 'code' command in PATH
  exit /b 1
)

if not exist "%ROOT%\node_modules" (
  echo ==^> Instalando dependencias...
  pushd "%ROOT%"
  call npm install || (popd & exit /b 1)
  popd
)

echo ==^> Compilando...
pushd "%ROOT%"
call npm run build || (popd & exit /b 1)
popd

echo ==^> Abrindo VS Code com a extensao carregada...
if "%~1"=="" (
  code --extensionDevelopmentPath="%ROOT%" --new-window
) else (
  code --extensionDevelopmentPath="%ROOT%" --new-window "%~1"
)

echo Pronto. Procure o icone 'Tootega Cockpit' na barra lateral.
endlocal
