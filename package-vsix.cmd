@echo off
REM package-vsix.cmd — Gera o .vsix da extensao (wrapper do package-vsix.ps1).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0package-vsix.ps1" %*
