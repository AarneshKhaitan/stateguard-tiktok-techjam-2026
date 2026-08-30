# StateGuard — Devpost submission draft

## One-line pitch

StateGuard makes agent behavior releasable: it runs a known-good Agent and a
candidate against the same workspace state, blocks new destructive effects,
and refuses to promote evidence that has gone stale.

## What we built

Coding Agents can be useful and dangerous at the same time. A normal test
suite can pass while an Agent deletes an unprotected but important file, and a
prompt can ask an Agent to be careful without enforcing it. StateGuard adds a
backend middleware boundary around the starter platform.

Every production Run executes in a staging copy. A diff and an independent
trusted verifier decide whether it can become the next immutable workspace
generation. Agent identity and policy are separate from the release. Before a
new release is promoted, StateGuard runs the active release and candidate
sequentially against the same generation, task, policy, and runtime. The
candidate is blocked if it deletes a path the baseline did not delete. A
successful certification is bound to a seven-field context fingerprint;
promotion is refused if the generation, policy, release, task, model, or Codex
version has drifted.

## Why the baseline comparison matters

The absolute gates intentionally allow many ordinary paths. The flagship case
is an unprotected `docs/legacy-notes.md` deletion: verification passes, the
change budget passes, and no protected path is touched. The baseline makes the
new destructive behavior visible anyway. In the recorded run, the baseline
added `NOTES.md`, the candidate deleted `docs/legacy-notes.md`, both absolute
gate lists were empty, and the differential gate returned that deletion.

## Technical stack

- TypeScript, Fastify, React, Vite, Vitest
- Volcengine Ark Responses API through Codex CLI
- Docker Desktop runtime with a local-process-compatible runner seam
- JSON metadata store with serialized mutations and atomic file replacement

## Architecture and repository

The architecture diagram and local instructions are in the repository
[README](../README.md). The implementation changes only the caller-provided
`workspacePath` at the existing `AgentRunner` seam; the starter runner is not
forked. The public repository URL should be added here before submission.

## Honest limitations

The persistent workspace is the transaction boundary, not external systems.
The generation publication is crash-safe, not atomic, and an orphaned
generation can remain after a crash. Symlinks and empty directories are not
tracked. A single stochastic execution is regression evidence, not proof of
causation. See the full limitations and language table in the README.

## Testing instructions

On Windows, use PowerShell for npm and start the POC with `bash run-local.sh`.
Use `RUNTIME_PROVIDER=local-process` for development when a container engine is
unavailable; the StateGuard design is provider-agnostic because it changes
only the workspace path passed to the runner.

```powershell
npm install
npx vitest run --pool=forks --maxWorkers=1
npm run typecheck
npm run build
```

## Team / track

TikTok TechJam 2026 — Track 1, Agent Middleware.
