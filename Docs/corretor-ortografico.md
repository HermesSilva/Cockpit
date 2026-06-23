# Corretor ortográfico (PT + EN) no composer

> Especificação de requisitos. Recurso novo: verificação ortográfica bilíngue no campo
> de digitação do prompt, com realce por cor e dropdown de correções por palavra.
> Status: **proposta** (aguardando aprovação para implementar).

---

## 1. Objetivo

Verificar a ortografia do texto digitado no **composer** (campo de prompt), realçar
palavras erradas com cor e, ao clicar numa palavra, abrir um dropdown com as possíveis
correções — **em PT e EN simultaneamente**, quando cabível.

### Decisões fixadas

| Decisão | Escolha |
|---------|---------|
| **Escopo** | Apenas o **composer** (input). Não marca a timeline. |
| **Idiomas** | **PT-BR + EN sempre ativos juntos.** Palavra só é erro se reprovar em *ambos*. |
| **Engine** | `nspell` + dicionários Hunspell (`dictionary-en`, `dictionary-pt-br`). |
| **Custo** | Zero. Tudo local, sem serviço de nuvem. |

---

## 2. Engine

**`nspell` (MIT) + `wooorm/dictionaries`** — Hunspell em JS puro, roda no webview.

- API: `.correct(word)` → bool, `.suggest(word)` → string[], `.add(word)`.
- Sem binário nativo; determinístico (independe do SO, ao contrário do Hunspell do sistema).
- Cada idioma = um par `index.aff` + `index.dic`.

### ⚠️ Licenças dos dicionários

O repositório `dictionaries` é MIT, **mas cada `.dic`/`.aff` mantém a licença de origem**:

- `dictionary-en` → deriva do **SCOWL** (permissivo, compatível com MIT).
- `dictionary-pt-br` → projeto **VERO/BrOffice**, normalmente **tri-licença LGPL / MPL / GPL**.
  Compatível com distribuir junto a um produto MIT, **mas exige atribuição e aviso de
  licença**.

**Requisito de release:** validar as licenças efetivas dos `.dic`/`.aff` empacotados e
incluir os avisos em `NOTICE` / `THIRD-PARTY`.

### Alternativas descartadas

| Opção | Motivo |
|-------|--------|
| `spellcheck=true` nativo do browser | Sem dropdown custom, sem cor por palavra, dicionário do SO. |
| Typo.js | Menos mantido que nspell. |
| Serviço online (LanguageTool etc.) | Viola non-goal "dados na máquina do usuário" + custo/latência. |

---

## 3. Ponto de integração

O composer **já tem o gancho ideal**: um `<pre class="composer-highlight">` (espelho de
syntax-highlight) renderizado **atrás** do `<textarea>`, alimentado por
`richHighlight(text)` (`webview/src/util/highlight.ts`). O texto do espelho é mantido
**idêntico em conteúdo** ao textarea, garantindo alinhamento por caractere.

→ O realce de erro é injetado **nesse mesmo overlay** (`<span class="spell-error">`),
sem nunca tocar o `<textarea>`. O dropdown ancora na posição da palavra via
`Range`/`getClientRects()` sobre o overlay.

---

## 4. Requisitos funcionais

### FR-1 — Detecção / tokenização

- Verificar **somente prosa**. Reusar as zonas que o `richHighlight` já distingue e
  **pular**: blocos cercados ` ``` `, código inline `` ` ``, `@menções`, `/slash`,
  caminhos (`src/x.ts`), URLs, e-mails, números, hex/UUID.
- Tokenizar respeitando acentos PT (`á-ú`, `ç`, `ã/õ`), apóstrofo e hífen
  (`guarda-chuva`, `it's`).
- **Não** marcar o token sob o cursor enquanto está sendo digitado (evita flicker);
  reavaliar ao sair da palavra.

### FR-2 — Bilíngue PT + EN simultâneo

- Palavra é **erro só se reprovar em PT *e* EN** → texto técnico misto não pinta
  `commit`, `deploy`, `arquivo`, `branch`.
- Sugestões no dropdown **agrupadas por idioma** (seção PT, seção EN); cada seção só
  aparece se aquele idioma tiver candidatos.
- Ambos os idiomas sempre ativos por padrão; settings permite desligar PT ou EN
  individualmente.

### FR-3 — Realce visual

- Pintar no overlay (`<span class="spell-error">`): underline ondulado + cor de tema
  (default `var(--vscode-editorError-foreground)`), **cor configurável**.
- Cor/estilo distinto para palavra **sem nenhuma sugestão** (desconhecida) vs. com
  sugestões.
- Conteúdo textual do overlay permanece idêntico ao textarea (regra de alinhamento).

### FR-4 — Dropdown de correção

- Clique na palavra → dropdown ancorado na palavra.
- Itens:
  - até **N sugestões** por idioma (config, default 7), agrupadas (PT / EN);
  - **Adicionar ao dicionário**;
  - **Ignorar** (só nesta sessão);
  - **Ignorar sempre** (persistente).
- Aplicar sugestão = substitui **apenas aquele intervalo** no texto, reposiciona o caret,
  recalcula a checagem.
- Teclado: ↑/↓ navega, Enter aplica, Esc fecha. `role=listbox`, acessível.
- Fecha ao: clicar fora, Esc, ou enviar a mensagem.

### FR-5 — Dicionário do usuário

- Palavras adicionadas persistem **na máquina** (estado da extensão / settings),
  aplicadas via `nspell.add()`.
- Reaproveitar o conceito do **dicionário de ditado** já existente, se a estrutura couber.
- *Decisão aberta:* dicionário único compartilhado PT+EN, ou um por idioma.

### FR-6 — Performance

- Carregar nspell + dicionários **lazy** (1º foco/digitação no composer).
- Rodar parse e checagem em **Web Worker** (dicionários = alguns MB; parse de `.aff`/`.dic`
  é custoso) para não travar a UI.
- Checagem **debounced** (~150–300 ms) e **incremental**: re-checar só tokens alterados,
  com cache de veredito por token.
- Limite de tamanho (não checar rascunho gigante), análogo ao `MAX` do highlight.

### FR-7 — Integração / conflitos

- Coexistir com o syntax-highlight: prosa recebe spell, código recebe hljs — nunca os
  dois no mesmo trecho.
- Coexistir com **correção de voz (Haiku)** e **restauração de rascunho**: não disparar
  checagem pesada a cada transcrição parcial do STT.

### FR-8 — i18n / acessibilidade

- Todos os rótulos do dropdown via i18n (`pt-BR` + `en`), conforme regra obrigatória.
- Navegável por teclado; `aria-*` no menu; cores respeitam o tema high-contrast.

### FR-9 — Configurações (settings)

- Ligar/desligar global.
- Ligar/desligar por idioma (PT, EN).
- Cor do realce.
- Nº máx. de sugestões.
- Tamanho máx. de texto verificado.

---

## 5. Não-objetivos

- Gramática / estilo (só ortografia).
- Verificação na timeline / mensagens já enviadas.
- Qualquer serviço de nuvem.

---

## 6. Decisões em aberto

1. Dicionário do usuário: único (PT+EN) ou um por idioma?
2. Variante europeia: incluir `dictionary-pt` (pt-PT) além de `dictionary-pt-br`?
3. Empacotar os dicionários no `.vsix` (tamanho) ou baixar sob demanda no 1º uso?

---

## 7. Esboço de implementação (não-normativo)

```
webview/src/spell/
  worker.ts        // nspell + dicionários; mensagens: check(tokens) -> veredito+sugestões
  useSpell.ts      // hook: debounce, cache por token, ciclo de vida do worker
  tokenize.ts      // tokenização ciente de zonas (reusa lógica do richHighlight)
  SpellDropdown.tsx// dropdown ancorado, agrupado por idioma, teclado/a11y
```
- O overlay de erro entra como uma camada/merge no `richHighlight` (ou um 2º `<span>`
  pass) restrito às zonas de prosa.
- Persistência do dicionário do usuário e settings via host (`postMessage`).
