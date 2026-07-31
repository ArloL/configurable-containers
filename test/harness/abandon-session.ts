// Not a test — the child half of the abandonment case in reaper-firefox.test.ts, which
// runs it and then kills it and asserts against what it left behind.
//
// It launches a real browser, reports where, and then just sits there: a session nobody
// will ever close, which is what a `beforeAll` past vitest's hookTimeout or a worker
// about to be killed is holding. This has to be a separate process because the thing
// under test is what happens to that browser when the process dies, and nothing inside
// the process can observe its own death.
import { launch } from "../../harness/firefox";

const session = await launch();
console.log(JSON.stringify({ profileDir: session.profileDir }));

// Deliberately no session.close(). Stay alive until the test signals us.
await new Promise<void>(() => {});
