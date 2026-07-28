// Shared by vitest.config.ts (`npm test`) and vitest.realtime.config.ts
// (`npm run test:realtime`, nightly). Both runs must see the SAME esbuild defines, or
// a test's meaning would depend on which config happened to run it.

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

export const ccDefines = {
  __CC_CONFIG_YAML__: JSON.stringify(TEST_CONFIG_YAML),
  // The unit tests exercise the echo branch, so it is defined here. buildExtension
  // defaults it to "" so no shipped bundle can contain it — asserted in
  // test/extension/package.test.ts.
  __CC_NOTIFY_ECHO_TO__: JSON.stringify("probe@configurable-containers.test"),
};
