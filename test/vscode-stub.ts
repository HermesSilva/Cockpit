// Stub mínimo da API do VSCode p/ os testes de unidade do host (vitest roda em
// node, sem o runtime do editor). Só cobre o que o código sob teste toca —
// hoje, o canal de log. Amplie conforme necessário.
export const window = {
  createOutputChannel: () => ({
    appendLine: (_msg: string) => {},
    dispose: () => {},
  }),
};
