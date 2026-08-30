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
