import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { diffTrees } from "./diff.js";
import { buildGhostJournal, replayGhostJournal } from "./ghost-replay.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("non-authoritative Ghost Replay", () => {
  it("reconstructs the candidate tree while the manifest remains ground truth", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stateguard-ghost-")); roots.push(root);
    const base = path.join(root, "base"); const candidate = path.join(root, "candidate"); const replayed = path.join(root, "replayed");
    await mkdir(path.join(base, "docs"), { recursive: true }); await writeFile(path.join(base, "keep.txt"), "keep", "utf8"); await writeFile(path.join(base, "docs", "old.md"), "old", "utf8");
    await mkdir(candidate, { recursive: true }); await writeFile(path.join(candidate, "keep.txt"), "changed", "utf8"); await writeFile(path.join(candidate, "new.txt"), "new", "utf8");
    const manifest = await diffTrees(base, candidate, "gen_0001"); const journal = await buildGhostJournal(base, candidate, manifest); await replayGhostJournal(base, replayed, journal);
    const replayDiff = await diffTrees(base, replayed, "gen_0001");
    expect(replayDiff.changes).toEqual(manifest.changes); expect(journal.map((event) => event.sequence)).toEqual([0, 1, 2]);
  });
});
