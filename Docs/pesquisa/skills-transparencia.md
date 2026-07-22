# Skills: o que o Claude Code CLI expõe de fato

**Data:** 2026-07-22 · **CLI:** 2.1.217 (`claude --version`) · **SO:** Windows 10
**Fontes:** capturas de sessão real em `%TEMP%/skillprobe` (stream-json por stdin/stdout),
`claude --help`, e strings do binário
`C:\Program Files\nodejs\node_modules\@anthropic-ai\claude-code\bin\claude.exe`.

Nada aqui é inferência: cada item traz o evento, a resposta ou a string que o sustenta.

---

## 1. O que o `system/init` traz

Além de `slash_commands`, o init tem um campo **`skills`** dedicado (hoje ignorado pelo
Cockpit — `src/session/Session.ts` só lia `slash_commands`):

```json
"slash_commands": ["caveman","deep-research","dataviz", … ,"usage","recap"],
"skills":         ["caveman","deep-research","dataviz","update-config", … ,"run"],
"agents":         ["claude","Explore","general-purpose","Plan","statusline-setup"],
"plugins":        [{"name":"dase-mcp","path":"…","version":"2.0.667"}, …]
```

A resposta do handshake `initialize` (control_response) traz as mesmas skills **com
descrição** e `argumentHint`.

---

## 2. Acionamento de skill no stream

### 2.1. Invocada pelo MODELO — visível

```jsonc
// assistant
{"type":"tool_use","id":"toolu_01MGQ…","name":"Skill","input":{"skill":"caveman","args":"full"}}
// user
{"type":"tool_result","tool_use_id":"toolu_01MGQ…","content":"Launching skill: caveman"}
"tool_use_result":{"success":true,"commandName":"caveman"}
// user (mensagem sintética com o CORPO do SKILL.md)
{"type":"text","text":"Base directory for this skill: C:\\Users\\…\\.claude\\skills\\caveman\n\n<corpo>"}
```

**Não existe evento discreto** (`system/skill_started` ou similar). O único sinal é esse
trio. O tamanho da mensagem sintética é a única base para estimar o custo do corpo.

**Existem DOIS caminhos, e só um carrega corpo.** Acionando `dataviz` (built-in), a captura
foi:

```jsonc
{"type":"tool_use","name":"Skill","input":{"skill":"dataviz"}}
{"type":"tool_result","content":"Execute skill: dataviz"}   // ← "Execute", não "Launching"
// … e NENHUMA mensagem `user` com o corpo. O modelo respondeu:
//    "Skill dataviz falhou ao carregar: `Execute skill: dataviz`."
```

Ou seja: `Launching skill: X` = o SKILL.md entrou no contexto; `Execute skill: X` = não
entrou nada. Marcar as duas como "carregada" seria falso — o Cockpit só marca a primeira.

### 2.2. Invocada pelo USUÁRIO (`/nome`) — invisível

Enviando `{"type":"user","message":{"content":[{"type":"text","text":"/caveman full"}]}}`,
o stream trouxe **apenas** o `assistant` já respondendo em modo caveman
(`cache_creation_input_tokens: 7132` contra ~2k de baseline). Sem `tool_use`, sem `system`.
Skill disparada por hook (`SessionStart`) também não gera nada.

---

## 3. Descarregar UMA skill do contexto: não existe

- Estado interno `invokedSkills: Map<name,{skillName,skillPath,content,invokedAt,agentId}>`
  (string do binário) é limpo só por funções internas — por `agentId` ou geral. Nenhum
  comando ou control_request expõe isso.
- `/skills` existe, mas é `{type:"local-jsx",name:"skills",description:"List available skills"}`
  — UI da TUI. **Não aparece em `slash_commands` no modo headless.**
- `/compact` não é escopado por skill.

**Restrição:** depois de injetado, o corpo do SKILL.md só sai com `/clear` ou sessão nova.

---

## 4. `get_context_usage`: metadados por skill sem gastar turno

O protocolo de controle (mesma família de `initialize`/`can_use_tool`) aceita, entre outros,
`get_context_usage`, `get_usage`, `read_file`, `reload_plugins`, `reload_skills`,
`set_mcp_servers`, `stop_task`, `get_settings`.

```json
{"type":"control_request","request_id":"ctx1","request":{"subtype":"get_context_usage"}}
```

Resposta real (recorte):

```json
"categories":[{"name":"System prompt","tokens":2947},{"name":"Skills","tokens":1928}, …],
"skills":{"totalSkills":14,"includedSkills":14,"tokens":1928,
  "skillFrontmatter":[{"name":"caveman","source":"userSettings","tokens":134},
                      {"name":"dataviz","source":"built-in","tokens":382}, …]},
"messageBreakdown":{"userMessageTokens":1885,
  "attachmentsByType":[{"name":"skill_listing","tokens":1540},{"name":"hook_success","tokens":1153}, …]},
"apiUsage":null
```

Fatos verificados:

1. Responde **antes do primeiro turno** (`apiUsage: null`) → é cálculo local: **zero tokens,
   zero linhas no transcript**. Não é slash command. (Diferente do bloqueio do S2, que
   dependia de rodar `/context`.)
2. `skills.skillFrontmatter[].tokens` = custo de **metadados** de cada skill.
3. A categoria `Skills` **não muda** ao acionar uma skill: medido 1928 antes e 1928 depois de
   invocar `dataviz`. O corpo cai em **Messages** e o CLI **não o atribui por skill** —
   `messageBreakdown` só tem agregados (`userMessageTokens`). Logo, tokens da skill ativa são
   **estimativa nossa** (chars ÷ 4) e devem ser rotulados como tal.

---

## 5. `skillOverrides`: a única alavanca real de custo

Schema do binário:

```
skillOverrides: Record<string, "on"|"name-only"|"user-invocable-only"|"off">
  'Per-skill listing overrides keyed by skill name. "name-only" lists the skill without its
   description; "user-invocable-only" hides it from the model but keeps /name; "off" hides it
   from both. Absent = on.'
disableBundledSkills: boolean  (≡ CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1)
```

Também existem as mensagens de erro `cmd_skill_override_off` ("Skill X is disabled via
skillOverrides…") e `sessionSkillAllowlist` ("Skill X is not in this session's skills allowlist").

Medição real com
`--settings '{"skillOverrides":{"dataviz":"off","claude-api":"name-only","deep-research":"user-invocable-only"}}'`:

| skill | override | tokens antes | tokens depois |
|---|---|---:|---:|
| `dataviz` | `off` | 382 | removida do listing |
| `deep-research` | `user-invocable-only` | 162 | removida do listing |
| `claude-api` | `name-only` | 361 | **4** |
| **categoria `Skills`** | | **1928** | **1027** |

Diferença: 901 = 382 + 162 + 357 (bate exato).

`claude --help`: `--settings <file-or-json>` — "Path to a settings JSON file **or a JSON
string** to load **additional** settings from" (merge, não substituição). É assim que o
Cockpit aplica os overrides sem tocar no `~/.claude/settings.json` do usuário.

**Cuidado medido:** o JSON *inline* funciona quando digitado no shell, mas **não** quando
passado por `spawn(..., {shell:true})` no Windows — o cmd.exe mastiga aspas/chaves e o CLI
sobe sem os overrides (silenciosamente). O Cockpit grava um arquivo temporário e passa o
caminho.

### 5.1. Efeito numa skill JÁ carregada (medido)

Mesma sessão, respawn com `--resume` e `{"caveman":"off"}`:

```
listing 1928 → 1794 tk (−134, exatamente os metadados) · caveman sai do listing
Messages 7168 → 7168 tk  ← o corpo já carregado NÃO sai
```

Confirma a restrição da seção 3: o override impede relistar/re-disparar, não descarrega.

---

## 6. Consequências para o Cockpit

| Pergunta | Resposta com base no que foi medido |
|---|---|
| Metadados por skill | ✅ `get_context_usage` (sem turno, sem token) |
| Skill acionada pelo modelo | ✅ `tool_use` `Skill` + mensagem com o corpo |
| Skill acionada por `/nome` no Cockpit | ✅ só porque **nós** enviamos (o stream não conta) |
| Skill acionada por hook / fora do Cockpit | ❌ invisível |
| Tokens exatos do corpo por skill | ❌ o CLI não atribui — só estimativa |
| Descarregar uma skill do contexto | ❌ não existe; `/clear` ou sessão nova |
| Reduzir o custo do listing | ✅ `skillOverrides` (efeito no próximo spawn) |
