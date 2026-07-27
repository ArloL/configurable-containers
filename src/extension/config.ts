// Fixed config bundled into the L4 extension. Config-from-storage / the editor UI
// are a later slice; this is enough to prove routing end-to-end in real Firefox.
export const BUNDLED_CONFIG_YAML = `
rules:
  - match: work.example
    open: Work
`;
