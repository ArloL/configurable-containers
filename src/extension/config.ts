// The config YAML is injected at build time by esbuild via __CC_CONFIG_YAML__
// (see harness/build-extension.ts). Config-from-storage / the editor UI are a
// later slice; for now the config is baked in at build time — the test harness
// injects the test config, the manual launcher injects the user's real config.
declare const __CC_CONFIG_YAML__: string;
export const BUNDLED_CONFIG_YAML: string = __CC_CONFIG_YAML__;
