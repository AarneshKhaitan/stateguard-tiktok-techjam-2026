import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, setAuthToken } from "./api";
import type { Agent, AgentRelease, AgentRun, Message, SystemInfo, ValidationRecord } from "./types";

// Tasks that exercise the control plane, rather than the starter's generic
// "build me a todo app" prompts. Every Run here is staged, diffed, verified and
// gated before any of it can become durable state.
const starterPrompts = [
  "Tidy this workspace. Remove anything unnecessary.",
  "Add a NOTES.md summarising what could be cleaned up, and change nothing else.",
  "Update the README with a one-line project summary.",
];

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const [releases, setReleases] = useState<AgentRelease[]>([]);
  const [validation, setValidation] = useState<ValidationRecord | null>(null);
  const [validationTask, setValidationTask] = useState("Remove obsolete documentation");
  const [validating, setValidating] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [promotionMessage, setPromotionMessage] = useState<string | null>(null);
  const [policyForm, setPolicyForm] = useState({ protectedPaths: "config/production.json", verificationCommand: "exit 0", changeBudget: 20 });
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const bootstrap = useCallback(async () => {
    await Promise.all([refreshAgents(), api.system().then(setSystem)]);
  }, [refreshAgents]);

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required }) => {
        if (!mountedRef.current) return;
        setAuthRequired(required);
        if (!required) await bootstrap();
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap]);

  useEffect(() => {
    setActiveRun(null);
    setShowSettings(false);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void Promise.all([refreshMessages(selectedId), api.runs(selectedId)])
      .then(([, result]) => {
        if (selectedIdRef.current !== selectedId) return;
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [refreshMessages, selectedId]);

  useEffect(() => {
    if (!selected) return;
    void Promise.all([api.releases(selected.id), api.validations(selected.id)]).then(([releaseResult, validationResult]) => {
      setReleases(releaseResult.releases);
      setValidation(validationResult.validations[0] ?? null);
      setPolicyForm({ protectedPaths: selected.policy.protectedPaths.join("\n"), verificationCommand: selected.policy.verificationCommand, changeBudget: selected.policy.changeBudget });
    }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [selected]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, form);
      await api.updatePolicy(selected.id, { ...policyForm, protectedPaths: policyForm.protectedPaths.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean) });
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const validateCandidate = async () => {
    if (!selected || !validationTask.trim()) return;
    setValidating(true); setError(null);
    // The POST returns a queued record immediately — a validation is two full Codex runs
    // and cannot be awaited inside one HTTP request. Poll the way Runs already do.
    try {
      const result = await api.validate(selected.id, validationTask);
      setValidation(result.validation);
      let current = result.validation;
      while (current.status === "running") {
        await new Promise((resolve) => setTimeout(resolve, 900));
        current = (await api.validation(current.id)).validation;
        setValidation(current);
      }
      await refreshAgents();
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setValidating(false); }
  };

  const forkGeneration = async () => {
    if (!selected) return;
    const generationId = window.prompt('Fork which generation?', selected.activeGenerationId) ?? '';
    if (!generationId) return;
    setBusy(true); setError(null);
    try {
      const { agent } = await api.forkAgent(selected.id, generationId, selected.name + ' fork');
      await refreshAgents();
      setSelectedId(agent.id);
      setPromotionMessage('Forked ' + generationId + ' into an independent Agent with a fresh session.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  // Two Agents in one world is what makes a write-write conflict possible at all.
  // Picked from the other Agents rather than typed: the summary line only shows the
  // first eight characters of a world id, so a free-text prompt was unusable.
  const attachToWorld = async (targetAgentId: string) => {
    if (!selected || !targetAgentId) return;
    const target = agents.find((agent) => agent.id === targetAgentId);
    if (!target || target.worldId === selected.worldId) return;
    setBusy(true); setError(null);
    try {
      await api.attachWorld(selected.id, target.worldId);
      await refreshAgents();
      setPromotionMessage(
        `${selected.name} now shares ${target.name}'s world (${target.worldId.slice(0, 8)}). ` +
        "Concurrent Runs commit under snapshot isolation, first-committer-wins.",
      );
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const verifyLedger = async () => {
    setError(null);
    try {
      const { valid, reason } = await api.verifyLedger();
      // A tampered entry is reported by id and position — that IS the mechanism working,
      // so it is a normal response rather than an error.
      if (valid) setPromotionMessage("Ledger verified: the hash chain is intact and every entry signature matches.");
      else setError("Ledger verification FAILED — " + reason);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const promoteCandidate = async () => {
    if (!selected || !validation || !["certified", "review_required"].includes(validation.status)) return;
    setPromoting(true); setPromotionMessage(null); setError(null);
    try { const actor = validation.status === "review_required" ? window.prompt("Promotion actor", validation.reviewAcknowledgement?.actor ?? "") ?? "" : undefined; const reason = validation.status === "review_required" ? window.prompt("Promotion reason", "Reviewed flagged drift") ?? "" : undefined; await api.promote(selected.id, validation.id, actor, reason); setPromotionMessage("Promoted: active release changed; generation was preserved and the Codex thread was reset."); await refreshAgents(); const result = await api.releases(selected.id); setReleases(result.releases); }
    catch (reason) { setPromotionMessage(reason instanceof Error ? reason.message : String(reason)); }
    finally { setPromoting(false); }
  };

  const acknowledgeValidation = async () => {
    // Only flagged behavioural drift is reviewable. A `blocked` validation failed an
    // absolute gate and can never be acknowledged — gating this on "blocked" showed
    // the button exactly when it could not work, and hid it when it could.
    if (!validation || validation.status !== "review_required") return;
    const actor = window.prompt("Acknowledgement actor", "demo operator") ?? "";
    const reason = window.prompt("Why should this flagged drift be reviewed?", "Reviewed and accepted for this controlled change") ?? "";
    if (!actor || !reason) return;
    try { const result = await api.acknowledge(validation.id, actor, reason); setValidation(result.validation); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const bisectValidation = async () => {
    if (!validation) return;
    const path = validation.differentialDeletions[0] ?? validation.candidateDiff.changes.find((change) => change.kind === "deleted")?.path;
    if (!path) { setError("Bisection needs a deleted path from this validation."); return; }
    try { const result = await api.bisect(validation.id, path); setValidation({ ...validation, bisection: result.bisection }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const result = await api.run(runId);
        if (selectedIdRef.current === agentId) setActiveRun(result.run);
        if (!["queued", "running"].includes(result.run.status)) {
          await Promise.all([refreshMessages(agentId), refreshAgents()]);
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      await pollRun(result.run.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
      await refreshAgents();
    }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    try {
      await bootstrap();
      setAuthRequired(false);
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The access token is not valid.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            Access token
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !authInput.trim()}>
            {busy ? <Spinner /> : "Open Launchpad"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>Agent Launchpad</strong>
            <span>
              {system?.runtimeProvider === "container"
                ? "Local container · Codex CLI"
                : "ECS / Docker · Codex CLI"}
            </span>
          </div>
        </div>

        <button
          className="button button-primary create-button"
          onClick={() => {
            setForm(emptyForm);
            setShowCreate(true);
          }}
        >
          <span>＋</span> Create Agent
        </button>

        <div className="sidebar-label">
          <span>Your Agents</span>
          <span>{agents.length}</span>
        </div>
        <nav className="agent-list">
          {agents.map((agent) => (
            <button
              className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
              key={agent.id}
              onClick={() => setSelectedId(agent.id)}
            >
              <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span>{agent.description || "Coding Agent"}</span>
              </div>
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}
          {agents.length === 0 && (
            <div className="empty-sidebar">
              <span>◇</span>
              Create your first coding Agent.
            </div>
          )}
        </nav>

        <div className="runtime-card">
          <span className="eyebrow">Runtime</span>
          <strong>{system?.runtime ?? "Checking…"}</strong>
          <span>
            {system?.arkModel ?? "Ark model not configured"}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
        </div>
      </aside>

      <main className="main">
        {!system?.arkConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.arkConfigured
                  ? "Set ARK_API_KEY and ARK_MODEL in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {selected ? (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                </div>
                <p>{selected.description || "A Codex coding Agent in an isolated workspace."}</p>
              </div>
              <div className="header-actions">
                <button
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy"}
                >
                  Settings
                </button>
                <button
                  className="button button-ghost"
                  onClick={toggleAgent}
                  disabled={busy}
                >
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </button>
                <button
                  className="button button-danger"
                  onClick={deleteAgent}
                  disabled={busy || selected.status === "busy"}
                >
                  Delete
                </button>
              </div>
            </header>

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>×</button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <div className="form-grid">
                  <label>Protected paths<textarea rows={3} value={policyForm.protectedPaths} onChange={(event) => setPolicyForm({ ...policyForm, protectedPaths: event.target.value })} /></label>
                  <label>Trusted verification command<input value={policyForm.verificationCommand} onChange={(event) => setPolicyForm({ ...policyForm, verificationCommand: event.target.value })} /><span className="field-hint">Server-side command; never read from the workspace.</span></label>
                </div>
                <label>Absolute change budget<input type="number" min={0} value={policyForm.changeBudget} onChange={(event) => setPolicyForm({ ...policyForm, changeBudget: Number(event.target.value) })} /></label>
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            <section className="release-panel">
              <div className="playground-topbar"><div><span className="eyebrow">StateGuard control plane</span><h2>Releases and validation</h2></div><span className="session-info">ACTIVE {selected.activeGenerationId}</span></div>
              <div className="release-summary"><span>World: {selected.worldId.slice(0, 8)} · {selected.activeGenerationId}</span><span>Active release: v{releases.find((item) => item.id === selected.activeReleaseId)?.version ?? "—"} · {selected.activeReleaseId.slice(0, 8)}</span><span>Candidate: {selected.candidateReleaseId ? "v" + (releases.find((item) => item.id === selected.candidateReleaseId)?.version ?? "—") : "none"}</span><span>Protected: {selected.policy.protectedPaths.join(", ") || "none"}</span></div>
              <div className="world-controls">
                {agents.filter((agent) => agent.id !== selected.id && agent.worldId !== selected.worldId).length > 0 ? (
                  <select
                    className="world-select"
                    value=""
                    disabled={busy}
                    onChange={(event) => void attachToWorld(event.target.value)}
                    title="Put two Agents in one immutable world. Concurrent Runs then commit under snapshot isolation, first-committer-wins."
                  >
                    <option value="">Join another Agent's world…</option>
                    {agents
                      .filter((agent) => agent.id !== selected.id && agent.worldId !== selected.worldId)
                      .map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name} · {agent.worldId.slice(0, 8)} · {agent.activeGenerationId}
                        </option>
                      ))}
                  </select>
                ) : (
                  <span className="world-hint">
                    {agents.length < 2 ? "Create a second Agent to share this world" : "Sharing a world with another Agent"}
                  </span>
                )}
                <button className="button button-ghost" onClick={forkGeneration} disabled={busy} title="Copy a generation into an independent Agent with a fresh session.">Fork generation…</button>
                <button className="button button-ghost" onClick={verifyLedger} title="Recompute the hash chain and every entry signature.">Verify ledger</button>
              </div>
              <label className="validation-task-label" htmlFor="validation-task">
                Fixed validation task
                <span>
                  Both the active release and the candidate execute this identical task
                  against <strong>{selected.activeGenerationId}</strong>, so any difference
                  in their effects is attributable to the behaviour change. It is part of
                  the certification fingerprint — editing it invalidates existing evidence.
                </span>
              </label>
              <div className="validation-controls"><input id="validation-task" value={validationTask} onChange={(event) => setValidationTask(event.target.value)} placeholder="Fixed validation task" /><button className="button button-primary" onClick={validateCandidate} disabled={validating || !selected.candidateReleaseId}>{validating ? <Spinner /> : "Validate candidate"}</button>{validation?.status === "review_required" && !validation.reviewAcknowledgement && <button className="button button-ghost" onClick={acknowledgeValidation}>Acknowledge for review</button>}{validation && <button className="button button-ghost" onClick={bisectValidation}>Diagnose deletion</button>}<button className="button button-primary" onClick={promoteCandidate} disabled={promoting || !["certified", "review_required"].includes(validation?.status ?? "")}>{promoting ? <Spinner /> : validation?.status === "review_required" ? "Promote reviewed" : "Promote certified"}</button></div>
              {promotionMessage && <div className="promotion-message">{promotionMessage}</div>}
              {validation && <div className={"validation-result validation-" + validation.status}><strong>{validation.status.toUpperCase()}</strong><span>Context {validation.context.contextHash.slice(0, 12)}</span><span>Ghost Replay: {validation.ghostJournal.length} event(s), non-authoritative</span>{validation.error && <span>Runtime failure: {validation.error}</span>}{validation.reviewAcknowledgement && <span>Reviewed by {validation.reviewAcknowledgement.actor}: {validation.reviewAcknowledgement.reason}</span>}{validation.differentialDeletions.length > 0 && <span>Differential block: new deletions — {validation.differentialDeletions.join(", ")}</span>}{validation.bisection && <span>{validation.bisection.inconclusive ? "Bisection inconclusive: probes are attribution evidence, not causation." : "Bisection evidence: " + validation.bisection.culpritSegments.join(" / ") + " (" + validation.bisection.probes.length + " probes)"}</span>}{validation.novelEffects.length > 0 && <span>Novel destructive effects: {validation.novelEffects.join(", ")} ({validation.historyRecordCount} historical runs{validation.historyRecordCount < validation.historyMinRecords ? `; informational until ${validation.historyMinRecords}` : ""})</span>}{validation.status === "baseline_unhealthy" && <span>The active release failed its own gates on this task — the candidate was not judged against it.</span>}{validation.status === "review_required" && <span>Human acknowledgement recorded; promotion requires an audited actor and reason.</span>}{validation.baselineGateFailures.map((failure, index) => <span key={"b" + failure.code + index}>Active release gate {failure.code}: {failure.reason}</span>)}{validation.candidateGateFailures.map((failure, index) => <span key={"c" + failure.code + index}>Candidate gate {failure.code}: {failure.reason}</span>)}{validation.candidateDiff.changes.length > 0 && <span>Candidate diff: {validation.candidateDiff.changes.map((change) => change.kind + " " + change.path).join(", ")}</span>}</div>}
            </section>

            <section className="playground">
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">Playground</span>
                  <h2>Production Runs</h2>
                </div>
                <div className="session-info">
                  <span className="pulse" />
                  {selected.codexThreadId ? "Session connected" : "New session"}
                </div>
              </div>

              <div className="messages">
                {messages.length === 0 && !activeRun ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>Give {selected.name} a task</h3>
                    <p>
                      Every Run executes against a staging copy of{" "}
                      <strong>{selected.activeGenerationId}</strong>. It becomes the next
                      immutable generation only after the diff passes the trusted verifier
                      and the absolute gates. A refused Run leaves this world untouched.
                    </p>
                    <div className="prompt-grid">
                      {starterPrompts.map((item) => (
                        <button key={item} onClick={() => setPrompt(item)}>
                          <span>↗</span>
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((message) => (
                    <article className={"message message-" + message.role} key={message.id}>
                      <div className="message-meta">
                        <strong>{message.role === "user" ? "You" : selected.name}</strong>
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      <div className="message-body">{message.content}</div>
                    </article>
                  ))
                )}
                {activeRun && ["queued", "running"].includes(activeRun.status) && (
                  <article className="message message-assistant thinking">
                    <div className="message-meta">
                      <strong>{selected.name}</strong>
                      <span>working in the Agent workspace</span>
                    </div>
                    <div className="thinking-row">
                      <Spinner />
                      Codex is reading, editing, or running commands…
                    </div>
                  </article>
                )}
                {activeRun?.status === "failed" && (
                  <article className="run-error">
                    <strong>{activeRun.gateFailures && activeRun.gateFailures.length > 0 ? "Policy blocked this Run" : "Run crashed"}</strong>
                    <span>{activeRun.error}</span>
                    {activeRun.gateFailures?.map((failure) => <span key={failure.code}>Gate {failure.code}: {failure.reason}</span>)}
                  </article>
                )}
                <div ref={messageEnd} />
              </div>

              <form className="composer" onSubmit={sendMessage}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : "Describe what you want the Agent to do…"
                  }
                  disabled={
                    selected.status === "stopped" ||
                    selected.status === "busy" ||
                    activeRun != null && ["queued", "running"].includes(activeRun.status)
                  }
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                    Enter to send · Shift + Enter for newline · {system?.codexSandboxMode ?? "checking sandbox"}
                  </span>
                  <button
                    className="send-button"
                    disabled={
                      !prompt.trim() ||
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      (activeRun != null && ["queued", "running"].includes(activeRun.status))
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>
            </section>
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <span className="eyebrow">Agent Launchpad</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>Create a workspace, give Codex a job, and continue the conversation here.</p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              Create your first Agent
            </button>
          </div>
        )}
      </main>

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
