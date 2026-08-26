import type { WebDriver } from "selenium-webdriver";

export interface WaitOpts {
  timeout?: number;
}

export interface PageReport {
  /**
   * This page's own url, or `null` when its tab has gone. Null is not an edge case here:
   * the tab a poll was waiting on is exactly the one the extension is most likely to have
   * closed, and a report that threw rather than saying so is a report nobody gets.
   */
  url: string | null;
  title: string | null;
  /** The ids in this page's document; empty when it could not be read at all. */
  ids: string[];
  /**
   * Every window's url, in handle order, with `GONE` where a handle was listed and would
   * not answer. Kept rather than skipped: a tab dying mid-walk is the very churn a
   * diagnosis is being read about, and a shorter list would hide it.
   */
  tabs: string[];
}

/** What `PageReport.tabs` carries for a handle that was listed and had already gone. */
export const GONE = "<gone>";

export type LocatorState = "attached" | "detached" | "visible" | "hidden";

// The slice of Page a Locator needs. Declared here rather than imported from page.ts so
// the two modules do not depend on each other.
export interface PageContext {
  readonly driver: WebDriver;
  readonly handle: string;
  readonly defaultTimeout: number;
  switchHere(): Promise<void>;
  diagnose(): Promise<string>;
}
