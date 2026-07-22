// Minimal stub of the VSCode API for the host unit tests (vitest runs in
// node, without the editor runtime). It only covers what the code under test touches —
// today, the log channel. Extend it as needed.
export const window = {
  createOutputChannel: () => ({
    appendLine: (_msg: string) => {},
    dispose: () => {},
  }),
};
