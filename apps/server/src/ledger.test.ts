import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { Ledger } from "./ledger.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("tamper-evident ledger", () => {
  it("verifies the chain and identifies an edited historical entry", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stateguard-ledger-")); roots.push(root);
    const ledger = new Ledger(path.join(root, "ledger.json"), path.join(root, "ledger.key"));
    await ledger.initialize(); await ledger.append("validation", "agent-1", { status: "blocked" }); await ledger.append("promotion_refusal", "agent-1", { reason: "stale" });
    await ledger.verify();
    const entries = JSON.parse(await readFile(path.join(root, "ledger.json"), "utf8")) as Array<{ details: Record<string, unknown> }>;
    entries[1]!.details.reason = "edited";
    await writeFile(path.join(root, "ledger.json"), JSON.stringify(entries), "utf8");
    const reloaded = new Ledger(path.join(root, "ledger.json"), path.join(root, "ledger.key")); await expect(reloaded.initialize()).rejects.toThrow(/Ledger entry .* at position 1: signature mismatch/);
  });
});
