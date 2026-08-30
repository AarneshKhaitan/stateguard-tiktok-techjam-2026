import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { diffTrees } from "./diff.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function makeTrees(): Promise<[string, string]> {
  const root = await mkdtemp(path.join(tmpdir(), "diff-test-"));
  roots.push(root);
  const base = path.join(root, "base");
  const candidate = path.join(root, "candidate");
  await mkdir(path.join(base, "nested"), { recursive: true });
  await mkdir(path.join(candidate, "nested"), { recursive: true });
  await writeFile(path.join(base, "same.txt"), "same", "utf8");
  await writeFile(path.join(candidate, "same.txt"), "same", "utf8");
  return [base, candidate];
}

describe("workspace diff", () => {
  it("recognizes identical trees as empty", async () => {
    const [base, candidate] = await makeTrees();
    expect(await diffTrees(base, candidate, "gen_0001")).toMatchObject({ isEmpty: true, changes: [], baseGenerationId: "gen_0001" });
  });

  it("detects added, modified, and deleted files", async () => {
    const [base, candidate] = await makeTrees();
    await writeFile(path.join(base, "deleted.txt"), "gone", "utf8");
    await writeFile(path.join(base, "modified.txt"), "before", "utf8");
    await writeFile(path.join(candidate, "added.txt"), "new", "utf8");
    await writeFile(path.join(candidate, "modified.txt"), "after", "utf8");
    const diff = await diffTrees(base, candidate);
    expect(diff.addedCount).toBe(1);
    expect(diff.modifiedCount).toBe(1);
    expect(diff.deletedCount).toBe(1);
    expect(diff.changes.map((change) => [change.path, change.kind])).toEqual([
      ["added.txt", "added"],
      ["deleted.txt", "deleted"],
      ["modified.txt", "modified"],
    ]);
  });

  // No wall-clock assertion here on purpose: a Date.now() threshold is flaky on a
  // loaded machine and a randomly-red test is worse than no test. Vitest's own
  // timeout is the guard against a genuine hang; these assertions cover correctness
  // at a realistic tree size, which is what actually matters.
  it("diffs a 200-file tree correctly", async () => {
    const [base, candidate] = await makeTrees();
    await Promise.all(Array.from({ length: 200 }, (_, index) => writeFile(path.join(base, "nested", `file-${index}.txt`), String(index), "utf8")));
    await Promise.all(Array.from({ length: 200 }, (_, index) => writeFile(path.join(candidate, "nested", `file-${index}.txt`), String(index), "utf8")));

    expect(await diffTrees(base, candidate)).toMatchObject({ isEmpty: true, changes: [] });

    // One changed file among 200 must still be found, at the right nested path.
    await writeFile(path.join(candidate, "nested", "file-137.txt"), "changed", "utf8");
    const diff = await diffTrees(base, candidate);
    expect(diff.isEmpty).toBe(false);
    expect(diff.modifiedCount).toBe(1);
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]?.path).toBe("nested/file-137.txt");
  }, 30_000);
});
