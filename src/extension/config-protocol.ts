// The Save conversation, shared by the options page and the wiring so the two cannot drift
// on the message name or the reply's shape. Pure, like picker-protocol and pause-protocol:
// no browser, no DOM.
export const CONFIG_APPLY = "cc-config-apply";

// An empty object means applied cleanly. Both fields describe a config that IS already in
// effect — an apply never refuses, because storage is the truth and memory follows it.
export interface ConfigApplyResponse {
  // A snippet in the new config failed to register. Routing already follows the new config;
  // pages keep whatever the last successful registration left.
  scriptError?: string;
  // The stored text does not parse, so the EMPTY config was applied and every site opens in
  // a throwaway. Reachable through adoption only — the editor refuses to save one.
  configError?: string;
}
