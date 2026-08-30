// The AMO listing copy, as the JSON `web-ext sign --amo-metadata` merges into the submit
// body — so a release publishes the copy in amo/ rather than waiting for someone to paste
// it into the Developer Hub. The Hub keeps no version history of listing text, which is
// what made hand-editing it a one-way door.
//
// Both channels get the same copy. The dev add-on is unlisted and shows none of it
// publicly, which is exactly why it is worth sending: every push to main writes the copy
// somewhere the developer can read it, and that is the only rehearsal before a listed
// release makes it public.
//
// Deliberately narrow: `name`, `categories` and `license` are NOT sent. They never change,
// they are mandatory at add-on creation rather than per version, and a wrong value there
// is a rejected upload rather than a bad paragraph.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const COPY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../amo");

// AMO's own caps, one per field this document carries, read off the model fields the API
// validates against (addons-server: `src/olympia/addons/models.py` for the add-on's copy,
// `src/olympia/versions/models.py` for the version's). Enforced here because the
// alternative is learning about them from a rejected upload — which is how the
// `approval_notes` cap was learnt: `sign:dev` runs on EVERY push to main, so a document
// that had grown past 3000 characters failed the upload after the build had succeeded, and
// on a release it would fail after the tag was pushed.
//
// An exact record rather than a constant per field, so `test/extension/amo-metadata.test.ts`
// can compare it against the fields actually sent. The two AMO caps NOT here are the two
// fields this document deliberately does not carry — `release_notes` and
// `developer_comments`, both 3000 — and adding either without a row is what that comparison
// exists to catch.
export const AMO_FIELD_LIMITS = {
  /** `NoURLsField(max_length=250)` */
  summary: 250,
  /** `PurifiedMarkdownField(short=False, max_length=15000)` */
  description: 15_000,
  /** `models.TextField(max_length=3000)` */
  approval_notes: 3000,
} as const;

// The summary is a NoURLsField, which is NOT a rejection: its cleaner runs
// `URL_RE.sub("", …)` over the text and stores what is left, so a link pasted there is
// published as a sentence with a hole in it by an upload that reported success. This is
// AMO's own pattern (`src/olympia/amo/utils.py`).
const URL_RE = /https?:\/\/\S+/i;

export interface ListingCopy {
  summary: string;
  description: string;
  reviewerNotes: string;
}

export interface AmoMetadataOptions extends ListingCopy {
  version: string;
  timestamp: string;
  channel: "listed" | "unlisted";
}

export interface AmoMetadata {
  summary: Record<string, string>;
  description: Record<string, string>;
  version: { approval_notes: string };
}

export function readListingCopy(dir: string = COPY_DIR): ListingCopy {
  return {
    summary: readFileSync(path.join(dir, "summary.txt"), "utf8").trim(),
    description: readFileSync(path.join(dir, "description.md"), "utf8").trim(),
    reviewerNotes: readFileSync(path.join(dir, "reviewer-notes.txt"), "utf8"),
  };
}

function fill(text: string, values: Record<string, string>): string {
  const filled = text.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => values[key] ?? whole);
  const left = /\{\{\w+\}\}/.exec(filled);
  if (left) throw new Error(`unknown placeholder ${left[0]} in the listing copy`);
  return filled;
}

/**
 * Pure, because this is the half that can be wrong in a way nothing downstream reads: a
 * submit overwrites the live listing, and AMO keeps no history of what it said before.
 */
export function buildAmoMetadata(opts: AmoMetadataOptions): AmoMetadata {
  // A dev build is a different add-on — its own id, name and update_url — so a reviewer
  // rebuilding without --dev gets an xpi that cannot match the one they downloaded. It is
  // the only thing the two channels disagree about.
  const packageArgs = opts.channel === "unlisted" ? `${opts.version} --dev` : opts.version;

  const summary = fill(opts.summary, {});
  const description = fill(opts.description, {});
  const approvalNotes = fill(opts.reviewerNotes, {
    version: opts.version,
    timestamp: opts.timestamp,
    package_args: packageArgs,
  });

  // Measured AFTER substitution, because that is the document AMO validates and it is
  // LONGER than the template: `{{timestamp}}` is 13 characters of placeholder and 25 of
  // value. A file checked as written can sit under the cap while every upload of it is
  // rejected.
  for (const [field, text, whenEmpty] of [
    ["summary", summary, "publishing it would blank the listing"],
    ["description", description, "publishing it would blank the listing"],
    ["reviewer notes", approvalNotes, "a reviewer would be left no way to reproduce the build"],
  ] as const) {
    if (text.trim() === "") throw new Error(`empty ${field} — ${whenEmpty}`);
  }

  for (const [field, text, limit] of [
    ["summary", summary, AMO_FIELD_LIMITS.summary],
    ["description", description, AMO_FIELD_LIMITS.description],
    ["reviewer notes", approvalNotes, AMO_FIELD_LIMITS.approval_notes],
  ] as const) {
    if (text.length > limit) {
      throw new Error(`${field}: ${text.length} characters, over AMO's cap of ${limit}`);
    }
  }

  const url = URL_RE.exec(summary);
  if (url) {
    throw new Error(`the summary carries a url (${url[0]}) — AMO strips it silently rather than refusing the upload`);
  }

  return {
    summary: { "en-US": summary },
    description: { "en-US": description },
    version: { approval_notes: approvalNotes },
  };
}

/** Writes the file `web-ext sign --amo-metadata` reads, and returns its path. */
export function writeAmoMetadata(
  target: string,
  opts: Omit<AmoMetadataOptions, keyof ListingCopy>,
  copy: ListingCopy = readListingCopy(),
): string {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(buildAmoMetadata({ ...copy, ...opts }), null, 2) + "\n");
  return target;
}
