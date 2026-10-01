# "Executando em segundo plano" parece travado — causa apurada

**Data:** 2026-09-13
**Relato:** o card *Running in the background (1)* fica parado com `Bash · Aguardar antes de
recompilar`, e o usuário conclui que o processo travou.
**Veredito:** **não é processo preso — é falta de informação temporal no card.**

---

## O que foi medido (não inferido)

Comando lançado: `sleep 150; echo pronto`, via `Bash` com `run_in_background: true`.

| Hora | Fato observado | Como foi observado |
|---|---|---|
| 16:55:04 | `sleep.exe` PID 46348 inicia | `Get-CimInstance Win32_Process` — `CommandLine` = `sleep 150` |
| ~16:55:30 | `.output` do task vazio (0 byte) | `ls -la` no diretório de tasks |
| ~16:56 | **O usuário interrompe**: o card continuava mostrando "(1)" | relato + captura de tela |
| 16:57:15 | PID 46348 **vivo há 131s** — dentro dos 150 pedidos | `Get-Process -Id 46348`, `StartTime` |
| 16:57:34 | processo termina, grava `pronto`, exit 0 | mtime do `.output` + conteúdo |
| 16:57:35 | confirmação independente da morte do PID | monitor `until ! tasklist ... ; do sleep 2; done` |

**O processo cumpriu os 150 s exatos e saiu com código 0.** Nada travou. Em nenhum momento
houve evento perdido: `background_tasks_changed` / `task_notification` chegaram e o card
foi limpo corretamente.

## A causa

O card mostra **spinner + contagem + `tool` + `label`**, e **nada de tempo**. O contrato não
carrega timestamp:

```ts
// shared/protocol.ts:445
export interface BackgroundTask {
  id: string;    // tool_use id que a lançou
  tool: string;  // 'Workflow' | 'Task' | 'Bash' | …
  label: string; // o que ela faz
}
```

E o render (`webview/src/App.tsx:610-627`) desenha só isso:

```tsx
<span className="voice-spinner bg-tasks-spinner" aria-hidden="true" />
<span className="bg-tasks-title">{t('background.title')} ({tab.bgTasks.length})</span>
…
<span className="bg-task-tool">{task.tool}</span>
<span className="bg-task-label">{task.label}</span>
```

Consequência direta: **uma tarefa de 3 segundos e uma tarefa pendurada há 40 minutos
produzem pixels idênticos.** O spinner gira nos dois casos. Sem tempo decorrido, o usuário
não tem como distinguir "está trabalhando" de "morreu e o card ficou" — e o histórico desta
extensão ensina que a segunda hipótese é plausível (ver abaixo), então desconfiar é a
reação **racional**, não um engano do usuário.

O defeito é de **observabilidade**, não de máquina de estado.

## Por que a desconfiança é legítima (histórico)

O mesmo card já ficou preso de verdade, duas vezes, e ambas estão no CHANGELOG:

- **1.0.190** — a notificação de conclusão só era reconhecida como string; chegando como
  bloco `text` em array ou dentro do `content` de um `tool_result`, a tarefa ficava na lista.
- **1.0.208** — o rastreamento lia o texto `<task-notification>` das mensagens `user`, mas
  tarefa que termina **com um turno em voo** tem a notificação enfileirada pelo CLI e ela
  nunca sai no stdout como mensagem; `TaskStop` também não notificava. Corrigido
  reconciliando contra `background_tasks_changed`, com `task_id` como chave.

Ou seja: a máquina de estado foi endurecida duas vezes e hoje está correta — o que sobrou é
que **o card não prova que está correta**. Ele pede confiança sem oferecer evidência.

## Correção proposta (não aplicada)

1. `BackgroundTask` ganha `startedAt: number` (epoch ms), preenchido em `addBgTask` /
   `syncBgTasks` (`src/session/Session.ts:497` e `:515`).
2. O card exibe o decorrido por tarefa (`1m 42s`), com tick de 1 s no webview.
3. Acima de um limiar (p. ex. 5 min), destacar o item e oferecer ação — "ver saída" (o
   `.output` já existe em disco) e "encerrar" (`TaskStop`).

O item 1 sozinho já resolve o relato: com o tempo à vista, `2m 10s` num `sleep 150` se lê
como progresso normal, e `38m` num build se lê como problema — que é exatamente a distinção
que hoje não existe.

## Nota de método

O primeiro diagnóstico desta investigação foi **errado**: ao ver o PID vivo, concluiu-se
"processo preso" antes de comparar `StartTime` com o relógio. A comparação (131 s de 150)
desmentiu a conclusão. Registrado aqui porque o erro é instrutivo — *um processo vivo não é
um processo travado*, e a diferença só aparece medindo, nunca olhando.
