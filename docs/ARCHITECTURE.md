# Architecture

StateGuard is middleware inserted at the starter's own execution seam. The starter
mounts an Agent's persistent workspace directly into Codex, so a failed Run leaves
partial mutations behind and a behaviour change reaches production untested.
StateGuard changes what the platform hands to the Runner, and adds a release
control plane around it.

**The Agent never edits current state. It proposes the next state.**

## The seam

`AgentRunner.run({ agentId, workspacePath, prompt, threadId })` takes a
caller-provided path. StateGuard changes only what that path points at — a staging
copy instead of the live workspace. The starter's runners are unmodified and
unforked, and both the container and local-process providers work unchanged.

```mermaid
flowchart TB
    UI["React UI"] --> API["Fastify API"]
    API --> Service["AgentService"]
    Service --> Releases["Release model<br/>immutable, name+description+instructions"]
    Service --> Policy["GatePolicy<br/>server-side, separate axis"]
    Service --> Gen["Workspace generations<br/>immutable world state"]
    Gen -->|copy| Staging["staging/tx_runId"]
    Service --> Runner{"AgentRunner<br/>(unmodified)"}
    Runner --> Staging
    Staging --> Diff["Manifest diff"]
    Diff --> Verifier["VerificationRunner<br/>read-only, no Ark key"]
    Verifier --> Gates["Absolute gates"]
    Gates -->|pass| Publish["Publish next generation"]
    Gates -->|fail| Discard["Discard staging"]
    Service --> Ledger["Hash-chained ledger"]
```

## Execution model

Every Run — production or validation — follows the same path:

1. **Stage.** Copy the active generation to `staging/tx_<runId>`. Synthesize
   `AGENTS.md` from the executing release into staging only.
2. **Execute.** The Runner receives the staging path. It cannot reach the active
   generation.
3. **Observe.** Re-hash `AGENTS.md` (tamper detection), strip it, then compute the
   manifest diff against the base generation. The diff is the authoritative record of
   what happened.
4. **Verify.** An independent container runs the policy's command with the workspace
   mounted **read-only**, no `ARK_API_KEY`, and no `codex-home`. It runs after the
   diff and before publication, so a writable mount would let it deposit files that
   get committed without appearing in the diff.
5. **Gate.** Deterministic absolute gates evaluate the diff.
6. **Publish or discard.** Passing production Runs are renamed into the next
   generation and the ACTIVE pointer moves. Everything else is discarded, leaving the
   active generation byte-identical. Validation staging is *always* discarded.

## Release control

Releases version `name + description + instructions` together, because all three
feed `AGENTS.md`. Editing an Agent mints a candidate; it never patches in place.

**Policy is a separate axis from the release.** A release is what the Agent is
*told*; policy is what the platform *enforces*. Tightening a guardrail therefore
invalidates existing certifications rather than minting a candidate that needs
approval — folding policy into the release would mean re-running the Agent to
approve your own safety tightening.

### Validation

The active release and the candidate execute **sequentially, against the same base
generation, task, policy and runtime**, each with a fresh ephemeral Codex thread.
Neither touches production's thread. Their observed effects are compared.

| Outcome | Meaning | Promotable |
| --- | --- | --- |
| `CERTIFIED` | No absolute failure, no new destructive effect | Yes |
| `REVIEW_REQUIRED` | A deletion the baseline did not make. Not forbidden — new | Yes, with a recorded actor and reason |
| `BLOCKED` | An absolute gate failed | **Never** |
| `BASELINE_UNHEALTHY` | The active release failed its own gates; the candidate was not judged | No |

Absolute gates encode things that are forbidden outright, so they are terminal.
Behavioural drift is *not* forbidden — that is the entire point of comparing against
a baseline — so it escalates to a human instead of refusing.

### State-bound promotion

A certification is bound to a ten-field `ValidationContext`:

```
baselineReleaseHash   candidateReleaseHash
generationId          generationHash        <- content, not just the label
taskHash              policyHash
arkModel              codexVersion
sandboxMode           runtimeImage          <- enforcement context
```

Promotion recomputes all ten and refuses unless every field still matches, naming
which one drifted and its before/after values. `generationHash` matters because the
id is only a label: editing a file inside `generations/gen_0012` leaves it called
`gen_0012`, and evidence bound to the label alone would survive exactly the state
change it exists to detect.

This is optimistic concurrency control applied to release authority: *read v12, do
work, commit only if it is still v12* becomes *certify against gen_12, promote only
if production is still gen_12*.

## Concurrency

`JsonStore` serializes mutations through a promise queue. Every decision that
depends on Agent status — send, edit, policy change, validate, promote — is
**re-checked inside the serialized mutation**, not only in a read-only pre-flight,
because a snapshot read lets two callers both observe `ready`.

## Guarantees and limits

## Behavioural history

After a production Run has passed its absolute gates and published a non-empty
generation, StateGuard appends an `EffectRecord` to
`<dataDirectory>/history/<agentId>.jsonl`. The control-plane `JsonStore` intentionally
does not carry this growing evidence data. A cached in-memory envelope counts deleted
directory prefixes, modified prefixes, and exact touched paths. A candidate deletion
under a prefix never before deleted by that Agent is surfaced as `NOVEL_EFFECT`.

`NOVEL_EFFECT` is behavioural regression evidence, not an absolute policy gate. It
never appears in `candidateGateFailures`. Until `HISTORY_MIN_RECORDS` (five by default)
published records exist, it is explicitly informational; after that, it contributes to
`REVIEW_REQUIRED` and requires the existing audited acknowledgement path.

The generation commit is **crash-safe, not atomic**: the rename and the ACTIVE
pointer update are two operations, so a crash between them leaves a harmless
orphaned generation, never a missing or corrupted one. The persistent workspace is
the transaction boundary; external side effects are outside it. See the README for
the full limitations list and the language table.
