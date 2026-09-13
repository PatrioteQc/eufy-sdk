import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
/** The fixture guides, beside the CI script that reads them rather than in the shipped source tree. */
const FIXTURES = join(ROOT, "scripts", "ci", "__fixtures__", "doc-snippets");

/**
 * The guard's own guard.
 *
 * `scripts/ci/check-doc-snippets.mjs` exists because two snippets in `docs/vacuums.md` did not compile and
 * a reviewer found them rather than CI. Taking on faith that the checker catches that class would be the
 * same mistake in a new place — so it is run here against fixture guides carrying those exact two bugs,
 * and against one that compiles.
 *
 * `--docs` points it at the fixtures, so the real run cannot see them and this one cannot be broken by
 * editing a guide.
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
  it("catches both of the bugs it was built for, at the lines they are on", () => {
    const { code, output } = run(join(FIXTURES, "broken"));
    expect(code).not.toBe(0);
    // The two bugs. A setter that does not exist — the guide said `setLevel`, the member's `writeAs` is
    // `setSuctionLevel` — and a method read as a property, so `.find` was called on the function itself.
    expect(output).toContain("Property 'setLevel' does not exist");
    expect(output).toContain("Property 'find' does not exist");

    // The EXACT markdown lines, which is the claim worth pinning: reporting against the generated file
    // would make the output unusable, and reporting against the right file at the wrong line is worse
    // than useless because it sends a reader to innocent code. `\d+` passed for any integer while every
    // number was one too high — so the numbers are spelled out here.
    //
    //   guide.md:7 → `await dev.suction?.()?.setLevel?.(2);`
    //   guide.md:9 → `const first = scenes?.find(…);`
    expect(output).toMatch(/broken[/\\]guide\.md:7:\d+ .*'setLevel'/);
    expect(output).toMatch(/broken[/\\]guide\.md:9:\d+ .*'find'/);
  }, 120_000);

  it("passes a guide that compiles, including its skip and host markers", () => {
    // Three snippets: one real, one marked `skip` (a shape sketch that is not a statement), and one
    // naming a host function through `host`. All three have to be accepted for the run to be green.
    const { code, output } = run(join(FIXTURES, "clean"));
    expect(output).toContain("documented snippets typecheck");
    expect(code).toBe(0);
  }, 120_000);
});
