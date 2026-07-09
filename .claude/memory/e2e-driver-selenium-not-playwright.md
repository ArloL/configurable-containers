---
name: e2e-driver-selenium-not-playwright
description: "The Firefox E2E harness uses Selenium/geckodriver because Playwright can't see WebExtension container tabs"
metadata: 
  node_type: memory
  type: project
  originSessionId: ce98b98b-fa9b-4ac4-82f8-3fe1e16891f6
---

The E2E test harness for configurable-containers drives Firefox via **Selenium/geckodriver against system Firefox** (headless), NOT Playwright.

Proven by the plumbing spike (branch `spike/e2e-harness-plumbing`, 2026-07-09): Playwright's Firefox (Juggler) is **structurally blind to WebExtension-opened container tabs** — a tab opened via `tabs.create({ cookieStoreId })` into a non-default container never surfaces in `context.pages()`, in BOTH `launchPersistentContext` and `.launch()` modes. `playwright-webextext` *does* load an unsigned MV2 extension headlessly, but that only covers default-store tabs. Selenium/geckodriver sees the container tab as an ordinary window handle and reads its `firefox-container-N` store directly.

**Why it matters:** this project's whole domain is routing tabs into containers, so nearly every L4/L5 test must observe a container tab — Playwright is disqualifying.

**How to apply:** keep the harness on `selenium-webdriver`. Observe container state via the probe extension writing `cookieStoreId` into `document.title` (`CSID:<store>`). Don't reintroduce Playwright for container-tab tests. Note TESTING.md still says "web-ext + Playwright" for L4/L5 and needs correcting. See [[compare-tooling-before-deciding]].
