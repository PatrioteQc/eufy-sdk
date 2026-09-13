import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The fixture guides, kept out of `docs/` so the real run cannot see them. */
const FIXTURES = join(HERE, "..", "__fixtures__", "doc-snippets");
const ROOT = join(HERE, "..", "..");

/**
 * The guard's own guard.
 *
 * `scripts/ci/check-doc-snippets.mjs` exists because two snippets in `docs/vacuums.md` did not compile and
 * a reviewer found them rather than CI. Taking on faith that the checker catches that class would be the
 * same mistake in a new place — so it is run here against fixture guides carrying those exact two bugs,
 * and against one that compiles.
 *
 * The fixtures live beside this spec rather than under `docs/`, so the real run cannot see them and this
 * one cannot be broken by editing a guide.
 */
function run(dir: string): { code: number; output: string } {
  try {
    const output = execFileSync("node", ["scripts/ci/check-doc-snippets.mjs", "--docs", dir], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: "pipe",
    });
    return { code: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("the doc-snippet checker", () => {
  it("catches both of the bugs it was built for", () => {
    const { code, output } = run(join(FIXTURES, "broken"));
    expect(code).not.toBe(0);
    // A setter that does not exist — the guide said `setLevel`, the member's `writeAs` is `setSuctionLevel`.
    expect(output).toContain("Property 'setLevel' does not exist");
    // A method read as a property — `scenes` is a method, so `.find` was called on the function itself.
    expect(output).toContain("Property 'find' does not exist");
    // Reported against the MARKDOWN, at the line the snippet really sits on, not against a generated file.
    expect(output).toMatch(/broken\/guide\.md:\d+:\d+/);
  }, 120_000);

  it("passes a guide that compiles, including its skip and host markers", () => {
    // Three snippets: one real, one marked `skip` (a shape sketch that is not a statement), and one
    // naming a host function through `host`. All three have to be accepted for the run to be green.
    const { code, output } = run(join(FIXTURES, "clean"));
    expect(output).toContain("doc snippets typecheck");
    expect(code).toBe(0);
  }, 120_000);

  it("refuses a skip with no reason", () => {
    // The reason is what makes a skip a decision rather than a convenience.
    const { code, output } = run(join(FIXTURES, "unreasoned"));
    expect(code).not.toBe(0);
    expect(output).toContain("typecheck:skip needs a reason");
  }, 120_000);
});
