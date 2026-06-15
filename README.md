# Tootega Cockpit for Claude Code

GUI rica para o **Claude Code**, como extensão nativa do VS Code. A UI é uma camada
de apresentação e controle **sobre o Claude Code CLI** — toda a orquestração (agente,
tools, subagentes, contexto, cache, permissões, MCP) vive no CLI.

> Autoria: **Tootega Pesquisa e Inovação** · Licença: **MIT** · Idiomas: **pt-BR** e **inglês internacional**.

## Destaques

- Transparência radical de consumo: contexto, cache, custo e limites da conta na tela.
- Controle humano configurável: do "aprovo cada passo" ao "deixa rodar".
- Inline diff, plan mode, checkpoints, timeline de tools.
- Bilíngue (pt-BR / inglês internacional), troca em runtime.

## Pré-requisitos

- VS Code ≥ 1.90
- Node.js ≥ 20
- **Claude Code CLI** instalado e autenticado (`claude` no PATH)

## Executar em desenvolvimento (sem instalar)

Abre o VS Code em modo **Extension Development Host** carregando a extensão direto do
código-fonte — não instala nada permanentemente.

**Windows (PowerShell):**

```powershell
./run-dev.ps1
# ou apontando para um projeto:
./run-dev.ps1 -OpenPath "C:\caminho\do\projeto"
# ou com recompilação automática ao salvar:
./run-dev.ps1 -Watch
```

**Windows (cmd):**

```bat
run-dev.cmd
run-dev.cmd C:\caminho\do\projeto
```

**Pelo próprio VS Code:** abra esta pasta e tecle `F5` (configuração *Executar extensão (dev)*).

Depois de abrir a janela de teste, abra o Cockpit como aba do editor: **Ctrl+Alt+C**,
o item **Cockpit** na status bar, ou a paleta (`Ctrl+Shift+P` → "Tootega: Open Cockpit").

## Build / empacotamento

```bash
npm install
npm run build        # compila host + webview para dist/
npm run typecheck    # checagem de tipos
npm run package      # gera o .vsix (requer @vscode/vsce)
```

## Estrutura

```
src/        host da extensão (TypeScript)
webview/    UI em React
shared/     schemas de eventos e protocolo host↔webview
l10n/       strings de runtime (vscode.l10n)
package.nls*.json  strings do manifesto
Docs/       documentação de planejamento
```
