# Third-Party Notices

Esta extensão é distribuída sob a licença MIT (ver `LICENSE`). Ela inclui e/ou
depende de componentes de terceiros, listados abaixo com suas respectivas
licenças. Os arquivos de dicionário são **dados** carregados em tempo de
execução, não código ligado ao binário.

## Dicionários ortográficos (empacotados em `dict/`)

### Inglês — `dict/en.aff`, `dict/en.dic`
Derivado do SCOWL (Spell Checker Oriented Word Lists) via projeto
`en_US` Hunspell — <http://wordlist.sourceforge.net>.
Licença permissiva estilo BSD/MIT. Texto completo em `dict/en.LICENSE.txt`.

### Português (Brasil) — `dict/pt-br.aff`, `dict/pt-br.dic`
Projeto VERO — Verificador Ortográfico do LibreOffice.
Autor: Raimundo Santos Moura e comunidade brasileira.
Copyright (C) 2006–2013.
Licenciado sob **GNU LGPL v3** e **Mozilla Public License (MPL)**, à escolha.
Texto completo em `dict/pt-br.LICENSE.txt`.
<http://pt-br.libreoffice.org/projetos/projeto-vero-verificador-ortografico/>

## Bibliotecas em tempo de execução

Empacotadas no bundle (`dist/`) via esbuild:

- `hunspell-asm` (MIT) — motor de verificação ortográfica em WebAssembly.
- `nspell` (MIT) — verificador ortográfico auxiliar.
- `highlight.js` (BSD-3-Clause) — realce de sintaxe.
- `qrcode` (MIT) — geração de QR Code.
- `ws` (MIT) — cliente WebSocket (ditado por voz).
- `react`, `react-dom` (MIT) — UI do webview.

As licenças completas de cada pacote estão nos respectivos diretórios em
`node_modules/` no repositório de origem.
