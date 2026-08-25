import type { WebDriver, WebElement } from "selenium-webdriver";

export interface FakeElement {
  getText?: () => Promise<string>;
  getRect?: () => Promise<{ width: number; height: number; x: number; y: number }>;
  getCssValue?: (name: string) => Promise<string>;
  isEnabled?: () => Promise<boolean>;
  getDomAttribute?: (name: string) => Promise<string | null>;
  getProperty?: (name: string) => Promise<unknown>;
  click?: () => Promise<void>;
  clear?: () => Promise<void>;
  sendKeys?: (...keys: string[]) => Promise<void>;
}

export interface FakeScript {
  /** What findElements answers on the nth call (1-based). */
  elements: (attempt: number) => FakeElement[];
  handles?: string[];
  url?: string;
  title?: string;
}

// A visible, enabled element, which is what most cases want their locator to find.
export function anElement(over: FakeElement = {}): FakeElement {
  return {
    getRect: async () => ({ width: 40, height: 20, x: 0, y: 0 }),
    getCssValue: async () => "visible",
    isEnabled: async () => true,
    ...over,
  };
}

// The semantics worth proving — re-resolves per poll, survives a stale element, survives a
// vanished window — are the ones a real browser will not reproduce on demand. That is the
// same reason the flakes this layer removes only ever appeared in CI.
export function fakeDriver(script: FakeScript): { driver: WebDriver; calls: string[] } {
  const calls: string[] = [];
  let attempt = 0;
  let current = script.handles?.[0] ?? "w1";
  const driver = {
    async findElements() {
      attempt++;
      calls.push(`findElements#${attempt}`);
      return script.elements(attempt) as unknown as WebElement[];
    },
    switchTo: () => ({
      async window(handle: string) {
        calls.push(`switchTo(${handle})`);
        current = handle;
      },
      async newWindow() {
        calls.push("newWindow");
        current = `w${(script.handles?.length ?? 1) + 1}`;
      },
    }),
    async getAllWindowHandles() {
      return script.handles ?? ["w1"];
    },
    async getWindowHandle() {
      return current;
    },
    async getCurrentUrl() {
      return script.url ?? "http://example.test/";
    },
    async getTitle() {
      return script.title ?? "a page";
    },
    async get(url: string) {
      calls.push(`get(${url})`);
    },
    async close() {
      calls.push("close");
    },
    actions: () => ({
      sendKeys(key: string) {
        calls.push(`sendKeys(${key})`);
        return { async perform() {} };
      },
    }),
  };
  return { driver: driver as unknown as WebDriver, calls };
}
