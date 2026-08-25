import type { WebDriver } from "selenium-webdriver";

export interface WaitOpts {
  timeout?: number;
}

export interface PageReport {
  url: string;
  title: string;
  ids: string[];
  tabs: string[];
}

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
