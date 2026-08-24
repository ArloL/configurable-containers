// Which YAML the extension actually runs: the user's stored config, the bundled first-run
// seed, or nothing at all when neither parses. Pure, so the decision is testable without a
// browser. See the 2026-07-28 design spec §3.
import { parseConfig, ConfigError } from "./parse";
import type { Config } from "../resolver/types";

export interface LoadResult {
  config: Config;
  error?: ConfigError; // set iff parsing failed
  seeded: boolean; // true iff there was no stored config
}

export function loadConfig(stored: string | undefined, seed: string): LoadResult {
  const seeded = stored === undefined;
  const yamlText = seeded ? seed : stored;
  try {
    return { config: parseConfig(yamlText), seeded };
  } catch (e) {
    // Empty config => nothing matches => every site gets a fresh throwaway. Never fall
    // back to the seed: months-stale rules are a silent wrong answer, throwaway-only a
    // loud one.
    const error = e instanceof ConfigError ? e : new ConfigError(String(e));
    return { config: { rules: [], groups: [] }, error, seeded };
  }
}
