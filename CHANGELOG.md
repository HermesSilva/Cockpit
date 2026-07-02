# Changelog

Todas as mudanças notáveis desta extensão são documentadas aqui.
O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.0.0/)
e o projeto adota versionamento semântico.

## [1.0.190] - 2026-07-02

### Adicionado
- Inventário de MCP/plugins: agrupamento de tools por servidor MCP a partir do
  evento `system/init` do CLI.
- Comandos **Tootega: Set/Remove Anthropic API key** para gerenciar a API key de
  descoberta de modelos.

### Alterado
- API key de descoberta de modelos migrada da setting `tootega.apiKey` (texto plano)
  para o **SecretStorage** (keychain do SO). Migração automática na primeira ativação;
  a setting é removida.
- Checkbox **DASE (ORM)** agora aparece apenas quando a extensão `tootega.dase` está
  instalada.

### Corrigido
- Elimina sessão-fantasma que ressurgia no Hub após apagar contextos.
- Ativa a extensão DASE para subir o servidor MCP sem `.dsorm` no workspace.
- Corrige crash do extension host por tempestade de reload de webview.

### Publicação
- Preparação para o VS Code Marketplace: aviso de não-afiliação com a Anthropic,
  `.vscodeignore` enxuto (remove scripts de dev e notas internas do pacote) e
  atribuição de licenças de terceiros (ver `THIRD-PARTY-NOTICES.md`).

## [1.0.0] - 2026-06

### Adicionado
- Primeira versão pública: chat com streaming, timeline de tools, diffs,
  checkpoints, painel de estatísticas/consumo, permissões, plan mode,
  ditado por voz, corretor ortográfico bilíngue e i18n pt-BR/en.
