// Two Selenium methods the e2e suite needs and `@types/selenium-webdriver` does not declare.
//
// They exist in `selenium-webdriver` itself and have for years — `getDomAttribute` and
// `getProperty` in `lib/webdriver.js` — but the DefinitelyTyped package stops at
// `getAttribute` (checked against 4.35.6, the newest published). Nothing to upgrade to, so
// they are declared here rather than reached through a cast at each call site.
//
// The suite needs them because they are real WebDriver protocol commands, where
// `getAttribute` is a SCRIPT Selenium injects: an extension page is a privileged browsing
// context and Firefox will not run one there. See harness/firefox.ts, on operating an
// extension page.
//
// Declaration merging: `WebElement` is a class, and an interface of the same name in the
// same module adds to its instance type. `WebElementPromise` extends `WebElement`, so both
// the element and the un-awaited `findElement(…)` get them.
declare module "selenium-webdriver" {
  interface WebElement {
    // The attribute as WRITTEN, with no property fallback: null when it is absent.
    getDomAttribute(attributeName: string): Promise<string | null>;
    // The live property — a textarea's `value`, which is not an attribute at all.
    getProperty(propertyName: string): Promise<string>;
  }
}

export {};
