// A `Decision` said in words. Pure — the same level as `resolve()`, and for the same
// reason: this is presentation of a resolver concept, not an engine effect.
//
// It sat in `engine.ts` while `engine/pause.ts` was its only outside consumer, which made
// the pause module — and, through the options page's imports, the options bundle — depend
// on the engine for two functions that touch nothing the engine owns. Down here neither
// edge exists, and `engine.ts` stays out of a page bundle by rule rather than by esbuild
// happening to tree-shake `createPause`.
import type { Decision } from "./types";

// The two decisions the engine performs by opening a tab, and so the two it cannot perform
// for a request with a body. Named because the F9 notification and the pause record must
// describe a declined action in the same words: one function, so the two cannot drift.
export type Declinable = Extract<Decision, { kind: "reopen" } | { kind: "choice" }>;

export function targetLabel(decision: Declinable): string {
  if (decision.kind === "choice") return `one of: ${decision.options.join(", ")}`;
  switch (decision.into.kind) {
    case "permanent":
      return decision.into.name;
    case "temporary":
      return "a new temporary container";
    case "default":
      return "the default container";
  }
}

// Whether a declined navigation is worth interrupting the user for. Narrows the
// NOTIFICATION only; the decline is unconditional, since the body would be dropped anyway.
//
// A toast earns its interruption by naming a container the config names: *stayed in tmp9
// instead of Haeger* says the login landed where it cannot work and points at the rule to
// fix. That is the SSO case this exists for.
//
// A temporary target cannot say that. *Stayed in tmp9 instead of a new temporary container*
// names two throwaways the user can neither tell apart nor act on — and that is the COMMON
// case: a card payment at an unmatched site, where the 3-D Secure host posts back cross-site
// and staying put is what makes checkout work. Silenced with it: a POST out of a permanent
// container that would have been isolated. It still names no unapplied rule and nothing to
// do, which is the line this draws. `default` sits with `temporary` — it is Firefox's
// no-container, not a rule's target.
export function namesAConfiguredContainer(decision: Declinable): boolean {
  // A choice always lists containers straight out of the config, `Temporary` among them
  // or not.
  return decision.kind === "choice" || decision.into.kind === "permanent";
}

// A decision — ANY decision, not only the two that can be declined — in one short phrase,
// for a diagnosis rather than for a user. `targetLabel` answers the user's question ("instead
// of what?"); this answers a test author's ("what did CC decide here?"), so it names the kind
// as well, and the two that leave a tab where it is are worth distinguishing: `leaveAlone` is
// "no rule had anything to say" and `stay` is "a rule did, and this tab already satisfies it".
export function describeDecision(decision: Decision): string {
  switch (decision.kind) {
    case "leaveAlone":
      return "leaveAlone (no rule and nothing to isolate)";
    case "stay":
      return "stay (already correctly contained)";
    case "reopen":
      return `reopen -> ${targetLabel(decision)}`;
    case "choice":
      return `choice -> ${targetLabel(decision)}`;
  }
}
