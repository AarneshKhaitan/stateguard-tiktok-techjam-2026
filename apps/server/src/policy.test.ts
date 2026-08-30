import { describe, expect, it } from "vitest";
import { defaultGatePolicy, evaluateAbsoluteGates, hashPolicy } from "./policy.js";
import type { WorkspaceDiff } from "./types.js";

const emptyDiff: WorkspaceDiff = {
  baseGenerationId: "gen_0001",
  changes: [],
  addedCount: 0,
  modifiedCount: 0,
  deletedCount: 0,
  isEmpty: true,
};
const passing = { passed: true, output: "ok", exitCode: 0 };
const change = (path: string, kind: "added" | "modified" | "deleted" = "modified") => ({ path, kind });

describe("absolute gate policy", () => {
  it("hashes policy content independently from Agent release content", () => {
    const policy = defaultGatePolicy();
    expect(policy.policyHash).toBe(hashPolicy(policy));
    expect(hashPolicy({ ...policy, changeBudget: policy.changeBudget + 1 })).not.toBe(policy.policyHash);
  });

  it("blocks a protected path independently", () => {
    const result = evaluateAbsoluteGates({ ...emptyDiff, changes: [change("config/production.json")] }, defaultGatePolicy(), passing);
    expect(result.failures).toEqual([{ code: "PROTECTED_PATH", reason: expect.stringContaining("config/production.json") }]);
  });

  it("blocks a change budget independently", () => {
    const policy = { ...defaultGatePolicy(), changeBudget: 1 };
    const result = evaluateAbsoluteGates({ ...emptyDiff, changes: [change("a"), change("b")] }, policy, passing);
    expect(result.failures).toEqual([{ code: "CHANGE_BUDGET", reason: expect.stringContaining("2 changes > 1") }]);
  });

  it("blocks a failed verifier independently", () => {
    const result = evaluateAbsoluteGates(emptyDiff, defaultGatePolicy(), { passed: false, output: "tests failed", exitCode: 1 });
    expect(result.failures).toEqual([{ code: "VERIFICATION", reason: "tests failed" }]);
  });

  it("blocks a runtime failure independently", () => {
    const result = evaluateAbsoluteGates(emptyDiff, defaultGatePolicy(), passing, "container exited");
    expect(result.failures).toEqual([{ code: "RUNTIME", reason: "container exited" }]);
  });

  it("blocks deletion and rewriting of platform-managed instructions", () => {
    expect(evaluateAbsoluteGates(emptyDiff, defaultGatePolicy(), passing, null, "Agent deleted platform-managed AGENTS.md").failures).toEqual([{ code: "AGENTS_TAMPERED", reason: "Agent deleted platform-managed AGENTS.md" }]);
    expect(evaluateAbsoluteGates(emptyDiff, defaultGatePolicy(), passing, null, "Agent rewrote platform-managed AGENTS.md").failures).toEqual([{ code: "AGENTS_TAMPERED", reason: "Agent rewrote platform-managed AGENTS.md" }]);
  });

  it("certifies when every absolute gate passes", () => {
    expect(evaluateAbsoluteGates(emptyDiff, defaultGatePolicy(), passing)).toEqual({ certified: true, failures: [] });
  });
});
