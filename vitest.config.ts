import { defineConfig } from "vitest/config";

// Mirrors the default TEST_CONFIG_YAML in harness/build-extension.ts — Vitest
// doesn't run through esbuild, so __CC_CONFIG_YAML__ must be defined here too.
const TEST_CONFIG_YAML = `
rules:
  - match: work.example
    open: Work
    cookies:
      - { name: seed, url: "http://work.example/", value: "1" }
    scripts:
      - { at: document_start, run: "localStorage.setItem('cc_script', '1');" }
  - match: redirect.example
    redirector: true
  - match: figma.example
    open: [Personal, Work]
  - match: youtube.example
    open: [Temporary, Personal]
    default: Temporary
`;

export default defineConfig({
  define: {
    __CC_CONFIG_YAML__: JSON.stringify(TEST_CONFIG_YAML),
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Run test files sequentially: several e2e/build tests bundle the CC extension
    // to the same extensions/cc/background.js, so parallel files would race on it.
    fileParallelism: false,
  },
});
