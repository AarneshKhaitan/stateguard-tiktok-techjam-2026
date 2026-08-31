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

  it("never inlines the contents of credential-shaped files", async () => {
    // The journal is persisted into launchpad.json and served to the browser, and the
    // challenge rules forbid exposing keys or unredacted secrets in either.
    const root = await mkdtemp(path.join(tmpdir(), "stateguard-ghost-secret-")); roots.push(root);
    const base = path.join(root, "base"); const candidate = path.join(root, "candidate");
    await mkdir(base, { recursive: true });
    await mkdir(candidate, { recursive: true });
    await writeFile(path.join(candidate, ".env"), "ARK_API_KEY=super-secret-value", "utf8");
    await writeFile(path.join(candidate, "server.key"), "-----BEGIN PRIVATE KEY-----", "utf8");
    await writeFile(path.join(candidate, "ordinary.txt"), "fine to inline", "utf8");

    const manifest = await diffTrees(base, candidate, "gen_0001");
    const journal = await buildGhostJournal(base, candidate, manifest);
    const byPath = Object.fromEntries(journal.map((event) => [event.path, event]));

    for (const secret of [".env", "server.key"]) {
      expect(byPath[secret]?.contentBase64).toBeUndefined();
      expect(byPath[secret]?.omitted).toBe("sensitive-path");
    }
    expect(byPath["ordinary.txt"]?.contentBase64).toBeDefined();
    // The structural event survives even when its content is withheld.
    expect(journal).toHaveLength(3);
    expect(JSON.stringify(journal)).not.toContain("super-secret-value");
  });

  it("withholds oversized content rather than bloating the metadata store", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stateguard-ghost-large-")); roots.push(root);
    const base = path.join(root, "base"); const candidate = path.join(root, "candidate");
    await mkdir(base, { recursive: true }); await mkdir(candidate, { recursive: true });
    await writeFile(path.join(candidate, "big.bin"), Buffer.alloc(200 * 1024, 1));
    await writeFile(path.join(candidate, "small.txt"), "small", "utf8");

    const manifest = await diffTrees(base, candidate, "gen_0001");
    const journal = await buildGhostJournal(base, candidate, manifest);
    const byPath = Object.fromEntries(journal.map((event) => [event.path, event]));
    expect(byPath["big.bin"]?.omitted).toBe("too-large");
    expect(byPath["big.bin"]?.contentBase64).toBeUndefined();
    expect(byPath["small.txt"]?.contentBase64).toBeDefined();
  });
});
