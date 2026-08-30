import { createHash } from "node:crypto";
import type { GateFailure, GatePolicy, VerificationResult, WorkspaceDiff } from "./types.js";

export const defaultGatePolicy = (): GatePolicy => {
  const policy = {
    protectedPaths: ["config/production.json"],
    verificationCommand: "sh -c 'exit 0'",
    changeBudget: 20,
  };
  return { ...policy, policyHash: hashPolicy(policy) };
};

export function hashPolicy(policy: Omit<GatePolicy, "policyHash"> | GatePolicy): string {
  const canonical = JSON.stringify({
    protectedPaths: [...policy.protectedPaths].map(normalizePath).sort(),
    verificationCommand: policy.verificationCommand,
    changeBudget: policy.changeBudget,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export interface GateEvaluation {
  certified: boolean;
  failures: GateFailure[];
}

export function evaluateAbsoluteGates(
  diff: WorkspaceDiff,
  policy: GatePolicy,
  verification: VerificationResult,
  runtimeFailure: string | null = null,
): GateEvaluation {
  const failures: GateFailure[] = [];
  const protectedPaths = policy.protectedPaths.map(normalizePath);
  const touchedProtected = diff.changes.filter((change) => protectedPaths.some((protectedPath) => isPathUnder(change.path, protectedPath)));
  if (touchedProtected.length > 0) failures.push({ code: "PROTECTED_PATH", reason: "Protected path touched: " + touchedProtected.map((change) => change.path).join(", ") });
  if (diff.changes.length > policy.changeBudget) failures.push({ code: "CHANGE_BUDGET", reason: "Change budget exceeded: " + diff.changes.length + " changes > " + policy.changeBudget });
  if (!verification.passed) failures.push({ code: "VERIFICATION", reason: verification.output || "Verification command failed with exit code " + verification.exitCode });
  if (runtimeFailure) failures.push({ code: "RUNTIME", reason: runtimeFailure });
  return { certified: failures.length === 0, failures };
}

function normalizePath(value: string): string { return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, ""); }
function isPathUnder(candidate: string, protectedPath: string): boolean {
  const normalized = normalizePath(candidate);
  return normalized === protectedPath || normalized.startsWith(protectedPath + "/");
}
