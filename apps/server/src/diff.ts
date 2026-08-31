import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { FileChange, WorkspaceDiff } from "./types.js";

interface TreeEntry {
  sha256: string;
  size: number;
}

async function walkTree(root: string, current = root): Promise<Map<string, TreeEntry>> {
  const entries = new Map<string, TreeEntry>();
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (entry.isDirectory()) {
      for (const [nestedPath, nestedEntry] of await walkTree(root, absolute)) entries.set(nestedPath, nestedEntry);
      continue;
    }
    if (!entry.isFile()) continue;
    const file = await readFile(absolute);
    const metadata = await lstat(absolute);
    entries.set(relative, { sha256: createHash("sha256").update(file).digest("hex"), size: metadata.size });
  }
  return entries;
}

export async function diffTrees(baseDir: string, candidateDir: string, baseGenerationId = "unknown"): Promise<WorkspaceDiff> {
  const [base, candidate] = await Promise.all([walkTree(baseDir), walkTree(candidateDir)]);
  const changes: FileChange[] = [];
  for (const relativePath of [...new Set([...base.keys(), ...candidate.keys()])].sort()) {
    const before = base.get(relativePath);
    const after = candidate.get(relativePath);
    if (!before && after) changes.push({ path: relativePath, kind: "added", afterHash: after.sha256, afterSize: after.size });
    else if (before && !after) changes.push({ path: relativePath, kind: "deleted", beforeHash: before.sha256, beforeSize: before.size });
    else if (before && after && before.sha256 !== after.sha256) changes.push({ path: relativePath, kind: "modified", beforeHash: before.sha256, afterHash: after.sha256, beforeSize: before.size, afterSize: after.size });
  }
  return {
    baseGenerationId,
    changes,
    addedCount: changes.filter((change) => change.kind === "added").length,
    modifiedCount: changes.filter((change) => change.kind === "modified").length,
    deletedCount: changes.filter((change) => change.kind === "deleted").length,
    isEmpty: changes.length === 0,
  };
}

/**
 * Content digest of a whole tree. `generationId` is only a label — a human or a
 * stray process can edit files inside generations/gen_0012 and the label still reads
 * gen_0012, so certification bound to the id alone would survive a state change it
 * was supposed to detect. Binding to content makes "the same world" mean the same
 * world. Order-independent: entries are sorted before hashing.
 */
export async function hashTree(dir: string): Promise<string> {
  const entries = await walkTree(dir);
  const canonical = [...entries.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relativePath, entry]) => relativePath + ":" + entry.sha256)
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}
