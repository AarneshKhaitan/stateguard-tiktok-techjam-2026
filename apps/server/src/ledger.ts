import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface LedgerEntry {
  id: string;
  kind: "validation" | "promotion" | "promotion_refusal";
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

  async verify(): Promise<void> {
    let previousHash = "";
    for (const [index, entry] of this.entries.entries()) {
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
