import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface LedgerEntry {
  id: string;
  kind: "validation" | "promotion" | "promotion_refusal" | "canary_rollback";
  agentId: string;
  details: Record<string, unknown>;
  createdAt: string;
  previousHash: string;
  hash: string;
  signature: string;
}

function canonical(value: unknown): string { return JSON.stringify(value); }

export class Ledger {
  private key!: Buffer;
  private entries: LedgerEntry[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string, private readonly keyPath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try { this.key = Buffer.from(await readFile(this.keyPath, "utf8"), "hex"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.key = randomBytes(32); await writeFile(this.keyPath, this.key.toString("hex") + "\n", { encoding: "utf8", mode: 0o600 });
    }
    try { this.entries = JSON.parse(await readFile(this.filePath, "utf8")) as LedgerEntry[]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await this.persist(); }
    await this.verify();
  }

  async append(kind: LedgerEntry["kind"], agentId: string, details: Record<string, unknown>): Promise<LedgerEntry> {
    let result!: LedgerEntry;
    const operation = this.queue.then(async () => {
      const payload = { id: randomUUID(), kind, agentId, details, createdAt: new Date().toISOString(), previousHash: this.entries.at(-1)?.hash ?? "" };
      const signature = createHmac("sha256", this.key).update(canonical(payload)).digest("hex");
      const entry = { ...payload, signature, hash: createHash("sha256").update(canonical({ ...payload, signature })).digest("hex") };
      this.entries.push(entry); await this.persist(); result = entry;
    });
    this.queue = operation.catch(() => undefined); await operation; return result;
  }

  /**
   * Verifies what is ON DISK, not what is in memory.
   *
   * The whole point of a tamper-evident ledger is to detect edits to the durable
   * record. Checking the in-process copy would pass happily while `ledger.json`
   * says something else entirely — the file is what survives, and the file is what
   * an auditor reads. Re-reading also means the check works on a running server,
   * rather than only after a restart.
   */
  async verify(): Promise<void> {
    let onDisk: LedgerEntry[];
    try { onDisk = JSON.parse(await readFile(this.filePath, "utf8")) as LedgerEntry[]; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return; // nothing written yet
      throw new Error("Ledger file is unreadable or not valid JSON: " + (error as Error).message);
    }
    if (!Array.isArray(onDisk)) throw new Error("Ledger file is not an array of entries");
    if (onDisk.length < this.entries.length) {
      throw new Error(`Ledger truncated: ${this.entries.length} entries recorded, ${onDisk.length} on disk`);
    }
    let previousHash = "";
    for (const [index, entry] of onDisk.entries()) {
      const { hash, signature, ...payload } = entry;
      if (entry.previousHash !== previousHash) throw new Error(`Ledger entry ${entry.id} invalid at position ${index}: previous hash mismatch`);
      const expectedSignature = createHmac("sha256", this.key).update(canonical(payload)).digest("hex");
      if (signature !== expectedSignature) throw new Error(`Ledger entry ${entry.id} invalid at position ${index}: signature mismatch`);
      const expectedHash = createHash("sha256").update(canonical({ ...payload, signature })).digest("hex");
      if (hash !== expectedHash) throw new Error(`Ledger entry ${entry.id} invalid at position ${index}: hash mismatch`);
      previousHash = hash;
    }
  }

  snapshot(): LedgerEntry[] { return structuredClone(this.entries); }
  private async persist(): Promise<void> { await writeFile(this.filePath, JSON.stringify(this.entries, null, 2) + "\n", { encoding: "utf8", mode: 0o600 }); }
}
