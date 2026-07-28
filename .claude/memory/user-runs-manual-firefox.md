---
name: user-runs-manual-firefox
description: "Don't launch npm run manual yourself — it opens a headed Firefox on the user's desktop; they run it and report back"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2904850c-d139-414c-89df-c19baa99976b
---

`npm run manual` (`harness/manual.ts`) opens a **headed** Firefox window on the user's own
machine and idles until Ctrl+C. When I started it in the background to verify a fix, the
user rejected the tool call and replied "I ran it. it works." They later drove it again
themselves and reported a precise symptom ("I get tmp1, then I type kottke.org and I'm in
tmp3, I expect tmp1").

**Why:** It hijacks their desktop, and a backgrounded headed session I cannot interact with
proves little anyway — the interesting steps (Cmd+T, typing in the URL bar) are ones only
they can perform. They are a willing and precise manual tester.

**How to apply:**
- Verify in *headless* Selenium via `harness/firefox.ts` — write a throwaway script in the
  scratchpad that drives the exact flow and prints observed state. That is what actually
  found both bugs here.
- When only a real interactive session will do, hand it over: say what to run and what to
  look for, and let them report.
- Take their symptom reports literally, including the numbers — "tmp3, not tmp2" was a real
  extra signal, and I could only reproduce `tmp2` locally. Say plainly which part of their
  report is reproduced and which is not, rather than rounding it off.

Related: [[e2e-driver-selenium-not-playwright]], [[critical-thinking-partner]]
