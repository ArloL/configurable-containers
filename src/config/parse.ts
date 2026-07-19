// Parse + normalize + validate the user's YAML config into the resolver's Config.
// See docs/superpowers/specs/2026-07-10-config-parser-design.md.
import { parse, YAMLParseError } from "yaml";
import { hostMatcher } from "../matcher/matcher";
import type { Action, Config, Group, Matcher, Rule } from "../resolver/types";

export class ConfigError extends Error {
  readonly path?: string;
  readonly line?: number;
  readonly col?: number;
  constructor(message: string, opts: { path?: string; line?: number; col?: number } = {}) {
    super(message);
    this.name = "ConfigError";
    this.path = opts.path;
    this.line = opts.line;
    this.col = opts.col;
  }
}

const ACTION_KEYS = ["open", "inherit", "ignore", "redirector"] as const;
const ALLOWED_RULE_KEYS = new Set([
  "match", "open", "default", "inherit", "ignore", "redirector", "cookies", "scripts",
]);

function isMapping(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Turn one raw `match` entry into a Matcher. Only bare hostnames are supported;
// match patterns and the regex object form raise a clear ConfigError.
function toMatcher(entry: unknown, path: string): Matcher {
  if (isMapping(entry) && "regex" in entry) {
    throw new ConfigError(`${path}: regex matches are not supported yet (bare hostnames only for now)`, { path });
  }
  if (typeof entry !== "string") {
    throw new ConfigError(`${path}: match entry must be a bare hostname string`, { path });
  }
  try {
    return hostMatcher(entry);
  } catch {
    throw new ConfigError(`${path}: "${entry}" is not a bare hostname (match patterns/regex not supported yet)`, { path });
  }
}

function parseMatch(raw: unknown, path: string): { matchers: Matcher[]; firstHost: string } {
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) {
    throw new ConfigError(`${path}.match must not be empty`, { path: `${path}.match` });
  }
  const matchers = list.map((e, j) => toMatcher(e, `${path}.match[${j}]`));
  return { matchers, firstHost: list[0] as string }; // toMatcher proved list[0] is a string
}

function parseOpen(raw: Record<string, unknown>, path: string): Action {
  const open = raw.open;
  let containers: string[];
  if (typeof open === "string") {
    containers = [open];
  } else if (Array.isArray(open)) {
    if (open.length === 0) throw new ConfigError(`${path}.open must not be empty`, { path: `${path}.open` });
    containers = open.map((c, j) => {
      if (typeof c !== "string") {
        throw new ConfigError(`${path}.open[${j}] must be a container name (string)`, { path: `${path}.open[${j}]` });
      }
      return c;
    });
  } else {
    throw new ConfigError(`${path}.open must be a string or a list of strings`, { path: `${path}.open` });
  }
  return { kind: "open", containers };
}

function parseRule(raw: unknown, i: number): Rule {
  const path = `rules[${i}]`;
  if (!isMapping(raw)) throw new ConfigError(`${path} must be a mapping`, { path });

  for (const k of Object.keys(raw)) {
    if (!ALLOWED_RULE_KEYS.has(k)) throw new ConfigError(`unknown key "${k}" in ${path}`, { path });
  }
  if (!("match" in raw)) throw new ConfigError(`${path} is missing "match"`, { path });
  const { matchers, firstHost } = parseMatch(raw.match, path);

  const present = ACTION_KEYS.filter((k) => k in raw);
  if (present.length > 1) {
    throw new ConfigError(`${path} has more than one action (${present.join(", ")}); a rule has at most one action`, { path });
  }

  let action: Action;
  if (present.length === 0) {
    action = { kind: "open", containers: [firstHost] }; // auto-name after the first host
  } else {
    switch (present[0]) {
      case "inherit":
        if (raw.inherit !== true) throw new ConfigError(`${path}.inherit must be true`, { path });
        action = { kind: "inherit" };
        break;
      case "ignore":
        if (raw.ignore !== true) throw new ConfigError(`${path}.ignore must be true`, { path });
        action = { kind: "ignore" };
        break;
      case "redirector":
        if (raw.redirector !== true) throw new ConfigError(`${path}.redirector must be true`, { path });
        action = { kind: "redirector" };
        break;
      default: // "open"
        action = parseOpen(raw, path);
    }
  }

  if ("default" in raw) {
    if (action.kind !== "open" || action.containers.length < 2) {
      throw new ConfigError(`${path}.default is only valid with a multi-value "open"`, { path: `${path}.default` });
    }
    const def = raw.default;
    if (typeof def !== "string") {
      throw new ConfigError(`${path}.default must be a container name`, { path: `${path}.default` });
    }
    if (!action.containers.includes(def)) {
      throw new ConfigError(`${path}.default "${def}" is not one of open: [${action.containers.join(", ")}]`, { path: `${path}.default` });
    }
    action = { ...action, default: def };
  }

  return { match: matchers, action };
}

export function parseConfig(yamlText: string): Config {
  let doc: unknown;
  try {
    doc = parse(yamlText);
  } catch (e) {
    if (e instanceof YAMLParseError) {
      const pos = e.linePos?.[0];
      throw new ConfigError(`YAML syntax error: ${e.message}`, { line: pos?.line, col: pos?.col });
    }
    throw e;
  }

  if (doc === null || doc === undefined) return { rules: [], groups: [] };
  if (!isMapping(doc)) throw new ConfigError("config must be a mapping with `rules` and/or `groups`");

  const rawRules = doc.rules ?? [];
  if (!Array.isArray(rawRules)) throw new ConfigError("`rules` must be a list", { path: "rules" });
  const rawGroups = doc.groups ?? [];
  if (!Array.isArray(rawGroups)) throw new ConfigError("`groups` must be a list", { path: "groups" });

  const rules = rawRules.map((r, i) => parseRule(r, i));
  const groups: Group[] = []; // group parsing added in Task 2
  return { rules, groups };
}
