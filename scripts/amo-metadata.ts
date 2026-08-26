// The AMO listing copy, as the JSON `web-ext sign --amo-metadata` merges into the submit
// body — so a release publishes the copy in amo/ rather than waiting for someone to paste
// it into the Developer Hub. The Hub keeps no version history of listing text, which is
// what made hand-editing it a one-way door.
//
// Deliberately narrow: `name`, `categories` and `license` are NOT sent. They never change,
// they are mandatory at add-on creation rather than per version, and a wrong value there
// is a rejected upload rather than a bad paragraph.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const COPY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../amo");

// AMO's own cap. Enforced here because the alternative is learning about it from a
// rejected upload, half way through a release that has already pushed its tag.
export const SUMMARY_LIMIT = 250;

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
  summary?: Record<string, string>;
  description?: Record<string, string>;
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
  // rebuilding without --dev gets an xpi that cannot match the one they downloaded.
  const packageArgs = opts.channel === "unlisted" ? `${opts.version} --dev` : opts.version;

  const meta: AmoMetadata = {
    version: {
      approval_notes: fill(opts.reviewerNotes, {
        version: opts.version,
        timestamp: opts.timestamp,
        package_args: packageArgs,
      }),
    },
  };

  // An unlisted add-on has no listing page: sending copy is at best ignored, and a
  // rejection would fail sign:dev on every push to main.
  if (opts.channel === "unlisted") return meta;

  for (const [field, text] of [
    ["summary", opts.summary],
    ["description", opts.description],
  ] as const) {
    if (text.trim() === "") throw new Error(`the ${field} is empty — publishing it would blank the listing`);
  }
  if (opts.summary.length > SUMMARY_LIMIT) {
    throw new Error(`the summary is ${opts.summary.length} characters, over AMO's cap of ${SUMMARY_LIMIT}`);
  }

  meta.summary = { "en-US": fill(opts.summary, {}) };
  meta.description = { "en-US": fill(opts.description, {}) };
  return meta;
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
