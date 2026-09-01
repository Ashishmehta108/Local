import { FormEvent, startTransition, useEffect, useEffectEvent, useState } from "react";
import { CoordinatorApi, type AuditEntry, type Device, type FileResult, type IndexedRoot, type Session, type User } from "./api";
import { agentStatus, configureAgent, createAgentIdentity, isTauri, startAgent, type AgentStatus } from "./agent";
import { HugeiconsIcon } from '@hugeicons/react';
import { Search01Icon, ComputerIcon, Clock04Icon, Settings02Icon, PlugSocketIcon } from '@hugeicons/core-free-icons';

const DEFAULT_COORDINATOR = import.meta.env.VITE_COORDINATOR_URL?.trim() || "https://filefinder-coordinator.onrender.com";
const REQUIRE_AGENT_CERTIFICATE = import.meta.env.VITE_REQUIRE_AGENT_CERTIFICATE !== "false";
const REQUIRE_AGENT_SIGNATURES = import.meta.env.VITE_REQUIRE_AGENT_SIGNATURES !== "false";

function savedSession(): Session | null {
  try { const saved = sessionStorage.getItem("session"); return saved ? JSON.parse(saved) as Session : null; }
  catch { sessionStorage.removeItem("session"); return null; }
}

function formatSize(value: string) {
  const bytes = Number(value);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function App() {
  const [coordinator, setCoordinator] = useState(localStorage.getItem("coordinator") ?? DEFAULT_COORDINATOR);
  const [session, setSession] = useState<Session | null>(savedSession);
  const [section, setSection] = useState<"search" | "devices" | "admin" | "history" | "settings">("search");
  const [theme, setTheme] = useState(localStorage.getItem("theme") || "light");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  const api = new CoordinatorApi(coordinator, session, signedIn);

  function signedIn(next: Session) {
    sessionStorage.setItem("session", JSON.stringify(next));
    localStorage.setItem("coordinator", coordinator);
    setSession(next);
  }

  if (!session) return <Login coordinator={coordinator} setCoordinator={setCoordinator} api={api} onSignedIn={signedIn} />;

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand"><span className="brand-mark">F</span><span>FileFinder</span></div>
        <nav aria-label="Primary">
          <button className={section === "search" ? "active" : ""} onClick={() => setSection("search")}><HugeiconsIcon icon={Search01Icon} size={16} />Search</button>
          <button className={section === "devices" ? "active" : ""} onClick={() => setSection("devices")}><HugeiconsIcon icon={ComputerIcon} size={16} />Computers</button>
          {session.user.role === "ADMIN" && <button className={section === "history" ? "active" : ""} onClick={() => setSection("history")}><HugeiconsIcon icon={Clock04Icon} size={16} />Activity</button>}
          {session.user.role === "ADMIN" && <button className={section === "admin" ? "active" : ""} onClick={() => setSection("admin")}><HugeiconsIcon icon={Settings02Icon} size={16} />Administration</button>}
          <button className={section === "settings" ? "active" : ""} onClick={() => setSection("settings")}><HugeiconsIcon icon={PlugSocketIcon} size={16} />Connection</button>
        </nav>
        <div className="rail-foot">
          <span className="status-dot" />Secure connection
          <button className="theme-toggle" onClick={() => setTheme(theme === "light" ? "dark" : "light")}>{theme === "light" ? "Dark" : "Light"}</button>
        </div>
      </aside>
      <main>
        {section === "search" && <Search api={api} />}
        {section === "devices" && <Devices api={api} isAdmin={session.user.role === "ADMIN"} coordinator={coordinator} onGoToConnection={() => setSection("settings")} />}
        {section === "history" && <ActivityHistory api={api} />}
        {section === "admin" && <Administration api={api} />}
        {section === "settings" && <Connection coordinator={coordinator} api={api} isAdmin={session.user.role === "ADMIN"} onSignOut={() => { sessionStorage.removeItem("session"); setSession(null); }} />}
      </main>
    </div>
  );
}

function Login({ coordinator, setCoordinator, api, onSignedIn }: { coordinator: string; setCoordinator: (value: string) => void; api: CoordinatorApi; onSignedIn: (session: Session) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { onSignedIn(await api.login(email, password)); } catch (cause) { setError(cause instanceof Error ? cause.message : "Sign in failed"); } finally { setBusy(false); }
  }

  return <div className="login-stage"><section className="login-card">
    <div className="eyebrow">PRIVATE WORKSPACE</div><h1>Find it where it lives.</h1>
    <p>Search approved folders across every connected office computer. File contents never leave their device.</p>
    <form onSubmit={submit}>
      <label>Coordinator address<input value={coordinator} onChange={(event) => setCoordinator(event.target.value)} required /></label>
      <label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required /></label>
      <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label>
      {error && <div className="error" role="alert">{error}</div>}
      <button className="primary" disabled={busy}>{busy ? "Connecting..." : "Enter workspace"}</button>
    </form>
  </section><div className="login-aside"><div className="network-map"><span>Secure coordinator</span><i /><span>Office PC 01</span><i /><span>Remote PC 02</span></div></div></div>;
}

function Search({ api }: { api: CoordinatorApi }) {
  const [query, setQuery] = useState(""); const [items, setItems] = useState<FileResult[]>([]); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function submit(event: FormEvent) { event.preventDefault(); if (!query.trim()) return; setBusy(true); setError(""); try { const result = await api.search(query); startTransition(() => setItems(result.items)); } catch (cause) { setError(cause instanceof Error ? cause.message : "Search failed"); } finally { setBusy(false); } }
  async function reveal(file: FileResult) { try { await api.createCommand(file.id); } catch (cause) { setError(cause instanceof Error ? cause.message : "Reveal failed"); } }
  return <div className="page"><header><div><div className="eyebrow">GLOBAL INDEX</div><h1>Search every computer</h1></div><div className="privacy-note">Metadata only</div></header>
    <form className="search-box" onSubmit={submit}><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filename, extension, or folder..." aria-label="Search files"/><button disabled={busy}>{busy ? "Searching" : "Search"}</button></form>
    {error && <div className="error" role="alert">{error}</div>}
    <div className="result-meta"><span>{items.length ? `${items.length} matches` : "Ready to search"}</span><span>Encrypted device connections</span></div>
    <section className="results">{items.map((file) => <article className="result" key={file.id}><div className="file-icon">{file.extension.slice(0, 4) || "FILE"}</div><div className="file-main"><h2>{file.name}</h2><p>{file.rootPath} / {file.relativePath}</p><div className="file-meta"><span className={`presence ${file.presence.toLowerCase()}`}>{file.presence}</span><span>{file.deviceName}</span><span>{formatSize(file.sizeBytes)}</span><span>{new Date(file.modifiedAt).toLocaleDateString()}</span></div></div><button className="reveal" disabled={file.presence !== "ONLINE"} onClick={() => reveal(file)}>Reveal</button></article>)}</section>
  </div>;
}

function Devices({ api, isAdmin, coordinator, onGoToConnection }: { api: CoordinatorApi; isAdmin: boolean; coordinator: string; onGoToConnection: () => void }) {
  const [items, setItems] = useState<Device[]>([]); const [roots, setRoots] = useState<IndexedRoot[]>([]); const [error, setError] = useState("");
  const [enrolModal, setEnrolModal] = useState(false);
  const [agentStat, setAgentStat] = useState<AgentStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: "Work PC", rootPath: "" });

  const load = useEffectEvent(async () => {
    try {
      const [devices, indexedRoots] = await Promise.all([api.devices(), api.roots()]);
      setItems(devices.items);
      setRoots(indexedRoots.items);
      if (isTauri()) {
        const stat = await agentStatus();
        setAgentStat(stat);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load devices");
    }
  });

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => clearInterval(timer);
  }, []);

  async function pause(device: Device) { await api.updateDevice(device.id, { state: device.state === "PAUSED" ? "ACTIVE" : "PAUSED" }); await load(); }
  
  async function removeDevice(device: Device) {
    if (!window.confirm(`Are you sure you want to remove ${device.name}? This computer will be un-enrolled.`)) return;
    try {
      await api.deleteDevice(device.id);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete device");
    }
  }

  async function toggleRoot(root: IndexedRoot) { if (root.enabled && !window.confirm(`Stop indexing ${root.canonicalPath}? Existing metadata will be hidden.`)) return; await api.updateRoot(root.id, !root.enabled); await load(); }

  async function selectFolder() {
    try {
      if (typeof window !== "undefined" && (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({ directory: true, multiple: false, title: "Select Folder to Index" });
        if (selected && typeof selected === "string") {
          setForm((prev) => ({ ...prev, rootPath: selected }));
          return;
        }
      }
    } catch { /* Ignored */ }
    const path = window.prompt("Enter folder path (e.g. C:\\Users\\Documents):", form.rootPath || "C:\\Users\\");
    if (path) setForm((prev) => ({ ...prev, rootPath: path }));
  }

  async function oneClickEnrol(e: FormEvent) {
    e.preventDefault();
    if (!form.rootPath) { setError("Please select an approved folder path."); return; }
    setBusy(true);
    setError("");
    try {
      const { code } = await api.createEnrolment();
      const { publicKey } = await createAgentIdentity();
      const enrolled = await api.enrolDevice(code, form.name, publicKey);
      const root = await api.addRoot(enrolled.deviceId, form.rootPath);
      await configureAgent({
        coordinatorUrl: coordinator,
        agentToken: enrolled.agentToken,
        commandSigningPublicKey: enrolled.commandSigningPublicKey,
        requireRequestSignatures: REQUIRE_AGENT_SIGNATURES,
        requireClientCertificate: false,
        clientCertificatePem: null,
        clientPrivateKeyPem: null,
        coordinatorCaPem: null,
        rootId: root.id,
        rootPath: form.rootPath
      });
      await startAgent();
      setEnrolModal(false);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Enrolment failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <header>
        <div>
          <div className="eyebrow">FLEET</div>
          <h1>Connected computers</h1>
        </div>
        <div className="header-actions">
          <div className="privacy-note">{items.length} enrolled</div>
          <button className="primary" onClick={() => setEnrolModal(true)}>+ Connect this computer</button>
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      {enrolModal && (
        <div style={{ background: "var(--surface-card)", border: "1px solid var(--hairline)", borderRadius: "var(--radius-lg)", padding: "24px", marginBottom: "24px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <div>
              <div className="eyebrow">STEP 1 OF 1</div>
              <h2 style={{ fontSize: "18px", margin: "4px 0 0", color: "var(--ink)" }}>Connect & Start Indexing</h2>
            </div>
            <button className="quiet" onClick={() => setEnrolModal(false)}>Cancel</button>
          </div>
          <p style={{ color: "var(--muted)", fontSize: "13px", margin: "0 0 16px" }}>
            We'll automatically generate a secure identity, register this machine, and start the background indexer.
          </p>
          <form onSubmit={oneClickEnrol} style={{ display: "grid", gap: "14px" }}>
            <label style={{ display: "grid", gap: "6px", fontSize: "12px", color: "var(--muted)", fontFamily: "var(--font-mono)" }}>
              Computer name
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={{ padding: "10px 12px", borderRadius: "8px", border: "1px solid var(--hairline)", background: "var(--canvas-soft)", color: "var(--ink)" }} required />
            </label>
            <label style={{ display: "grid", gap: "6px", fontSize: "12px", color: "var(--muted)", fontFamily: "var(--font-mono)" }}>
              Approved folder to index
              <div style={{ display: "flex", gap: "8px" }}>
                <input placeholder="C:\Users\Documents or D:\Projects" value={form.rootPath} onChange={(e) => setForm({ ...form, rootPath: e.target.value })} style={{ flex: 1, padding: "10px 12px", borderRadius: "8px", border: "1px solid var(--hairline)", background: "var(--canvas-soft)", color: "var(--ink)" }} required />
                {isTauri() && <button type="button" className="quiet" onClick={selectFolder}>Browse...</button>}
              </div>
            </label>
            <div style={{ display: "flex", gap: "10px", marginTop: "8px" }}>
              <button className="primary" disabled={busy}>{busy ? "Connecting & Indexing..." : "Start indexing now"}</button>
              <button type="button" className="quiet" onClick={onGoToConnection}>Advanced options</button>
            </div>
          </form>
        </div>
      )}

      {items.length === 0 ? (
        <div style={{ textAlign: "center", padding: "64px 20px", background: "var(--surface-card)", border: "1px solid var(--hairline)", borderRadius: "var(--radius-lg)" }}>
          <h2 style={{ fontSize: "20px", color: "var(--ink)", marginBottom: "8px" }}>No computers enrolled yet</h2>
          <p style={{ color: "var(--muted)", fontSize: "14px", marginBottom: "20px" }}>Click the button below to connect this computer and choose a folder to index.</p>
          <button className="primary" onClick={() => setEnrolModal(true)}>+ Connect this computer</button>
        </div>
      ) : (
        <section className="device-grid">
          {items.map((device) => (
            <article className="device" key={device.id}>
              <div className="device-top">
                <span className={`device-orb ${device.presence.toLowerCase()}`} />
                <span className="device-state" style={{ fontWeight: 600, color: device.presence === "ONLINE" ? "var(--success)" : "var(--muted)" }}>{device.presence}</span>
              </div>
              <h2>{device.name}</h2>
              <p>{device.os}</p>
              <dl>
                <div><dt>Last event</dt><dd>#{device.lastSequence}</dd></div>
                <div><dt>Last seen</dt><dd>{device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleTimeString() : "Never"}</dd></div>
              </dl>
              <div className="root-list">
                {roots.filter((root) => root.deviceId === device.id).map((root) => (
                  <button key={root.id} disabled={!isAdmin} onClick={() => toggleRoot(root)}>
                    <span>{root.canonicalPath}</span>
                    <b style={{ color: root.enabled ? "var(--success)" : "var(--muted)" }}>{root.enabled ? "INDEXED" : "DISABLED"}</b>
                  </button>
                ))}
              </div>
              <div style={{ display: "flex", gap: "6px", marginTop: "12px", borderTop: "1px solid var(--hairline)", paddingTop: "12px" }}>
                {isAdmin && device.state !== "REVOKED" && <button className="quiet" onClick={() => pause(device)}>{device.state === "PAUSED" ? "Resume" : "Pause"}</button>}
                <button className="quiet" style={{ color: "var(--error)", borderColor: "var(--hairline-strong)", marginLeft: "auto" }} onClick={() => removeDevice(device)}>Delete</button>
              </div>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}

function ActivityHistory({ api }: { api: CoordinatorApi }) {
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [error, setError] = useState("");
  const load = useEffectEvent(async () => {
    try {
      const result = await api.audit();
      setAudit(result.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load activity history");
    }
  });
  useEffect(() => { void load(); }, []);

  return (
    <div className="page">
      <header>
        <div>
          <div className="eyebrow">AUDIT LOG</div>
          <h1>History of changes</h1>
        </div>
        <div className="privacy-note">{audit.length} recent events</div>
      </header>
      {error && <div className="error">{error}</div>}
      <section className="history-section" style={{ background: "var(--paper)", border: "1px solid var(--line)", borderRadius: "14px", padding: "20px" }}>
        <div className="audit-list" style={{ maxHeight: "600px" }}>
          {audit.map((entry) => (
            <article key={entry.id} style={{ display: "flex", justifyContent: "space-between", padding: "14px 4px", borderBottom: "1px solid var(--line)" }}>
              <div style={{ display: "grid", gap: "4px" }}>
                <strong style={{ fontSize: "13px", color: "var(--ink)", textTransform: "capitalize" }}>{entry.action.replaceAll("_", " ").toLowerCase()}</strong>
                <span style={{ fontSize: "11px", color: "var(--muted)", fontFamily: "var(--mono)" }}>Target: {entry.targetType} ({entry.targetId || "N/A"})</span>
              </div>
              <time style={{ fontSize: "11px", color: "var(--muted)", fontFamily: "var(--mono)" }}>{new Date(entry.createdAt).toLocaleString()}</time>
            </article>
          ))}
          {audit.length === 0 && <p style={{ color: "var(--muted)", fontStyle: "italic" }}>No change history recorded yet.</p>}
        </div>
      </section>
    </div>
  );
}

function Administration({ api }: { api: CoordinatorApi }) {
  const [users, setUsers] = useState<User[]>([]); const [audit, setAudit] = useState<AuditEntry[]>([]); const [error, setError] = useState("");
  const [form, setForm] = useState({ email: "", password: "", role: "MEMBER" as "ADMIN" | "MEMBER" });
  const load = useEffectEvent(async () => { try { const [userResult, auditResult] = await Promise.all([api.users(), api.audit()]); setUsers(userResult.items); setAudit(auditResult.items); } catch (cause) { setError(cause instanceof Error ? cause.message : "Administration data failed to load"); } });
  useEffect(() => { void load(); }, []);
  async function create(event: FormEvent) { event.preventDefault(); try { await api.createUser(form.email, form.password, form.role); setForm({ email: "", password: "", role: "MEMBER" }); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create user"); } }
  return <div className="page"><header><div><div className="eyebrow">CONTROL</div><h1>Administration</h1></div></header>{error && <div className="error">{error}</div>}<div className="admin-grid"><section><div className="section-heading"><h2>Local users</h2><span>{users.length}</span></div><div className="user-list">{users.map((user) => <div key={user.id}><span>{user.email}</span><b>{user.role}</b></div>)}</div><form className="user-form" onSubmit={create}><input type="email" placeholder="new.user@office.local" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} required/><input type="password" minLength={12} placeholder="Temporary password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} required/><select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as "ADMIN" | "MEMBER" })}><option value="MEMBER">Member</option><option value="ADMIN">Administrator</option></select><button className="primary">Create user</button></form></section><section><div className="section-heading"><h2>Recent audit trail</h2><span>100 latest</span></div><div className="audit-list">{audit.map((entry) => <article key={entry.id}><div><strong>{entry.action.replaceAll("_", " ")}</strong><span>{entry.targetType}</span></div><time>{new Date(entry.createdAt).toLocaleString()}</time></article>)}</div></section></div></div>;
}

function Connection({ coordinator, api, isAdmin, onSignOut }: { coordinator: string; api: CoordinatorApi; isAdmin: boolean; onSignOut: () => void }) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const requiresClientCertificate = REQUIRE_AGENT_CERTIFICATE && showAdvanced;
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [form, setForm] = useState({
    code: "",
    name: "My Computer",
    rootPath: "",
    certificatePath: "C:\\ProgramData\\FileFinder Agent\\client.crt.pem",
    privateKeyPath: "C:\\ProgramData\\FileFinder Agent\\client.key.pem",
    certificateFingerprint: "",
    coordinatorCaPath: "C:\\ProgramData\\FileFinder Agent\\coordinator-ca.pem"
  });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (isTauri()) void agentStatus().then(setStatus); }, []);
  function field(name: keyof typeof form, value: string) { setForm((current) => ({ ...current, [name]: value })); }
  
  async function selectFolder() {
    try {
      if (typeof window !== "undefined" && (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({ directory: true, multiple: false, title: "Select Approved Folder to Index" });
        if (selected && typeof selected === "string") {
          field("rootPath", selected);
          return;
        }
      }
    } catch {
      // Ignored
    }
    const path = window.prompt("Enter approved folder path (e.g. D:\\Projects or C:\\Users\\Name\\Documents):", form.rootPath || "C:\\Users\\");
    if (path) field("rootPath", path);
  }

  async function enrol(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const { publicKey } = await createAgentIdentity();
      const certificateFingerprint = requiresClientCertificate ? form.certificateFingerprint.replaceAll(":", "") : undefined;
      const enrolled = await api.enrolDevice(form.code, form.name, publicKey, certificateFingerprint);
      const root = await api.addRoot(enrolled.deviceId, form.rootPath);
      await configureAgent({ coordinatorUrl: coordinator, agentToken: enrolled.agentToken, commandSigningPublicKey: enrolled.commandSigningPublicKey, requireRequestSignatures: REQUIRE_AGENT_SIGNATURES, requireClientCertificate: requiresClientCertificate, clientCertificatePem: requiresClientCertificate ? form.certificatePath : null, clientPrivateKeyPem: requiresClientCertificate ? form.privateKeyPath : null, coordinatorCaPem: requiresClientCertificate && form.coordinatorCaPath ? form.coordinatorCaPath : null, rootId: root.id, rootPath: form.rootPath });
      setStatus(await startAgent()); setMessage("This computer is enrolled and indexing has started.");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "Agent setup failed"); } finally { setBusy(false); }
  }
  return <div className="page narrow"><header><div><div className="eyebrow">NETWORK</div><h1>Connection</h1></div></header><section className="settings-card"><div><span>Coordinator</span><strong>{coordinator}</strong></div><div><span>Access mode</span><strong>Outbound HTTPS / WSS</strong></div><div><span>Local agent</span><strong>{status?.running ? "Running" : status?.configured ? "Configured" : "Not configured"}</strong></div><div><span>Indexed data</span><strong>Names, paths and metadata only</strong></div><div><span>File transfer</span><strong>Disabled</strong></div></section>
    {!status?.running && <form className="agent-setup" onSubmit={enrol}><div className="eyebrow">ENROL THIS COMPUTER</div>
      <label>One-time enrolment code<input value={form.code} onChange={(event) => field("code", event.target.value)} placeholder="Paste code here..." required /></label>
      <label>Computer name<input value={form.name} onChange={(event) => field("name", event.target.value)} required /></label>
      <label>Approved folder path
        <div style={{ display: "flex", gap: "8px" }}>
          <input placeholder="C:\\Users\\YourName\\Documents or D:\\Projects" value={form.rootPath} onChange={(event) => field("rootPath", event.target.value)} style={{ flex: 1 }} required />
          {isTauri() && <button type="button" className="quiet" onClick={selectFolder}>Browse...</button>}
        </div>
      </label>
      <button type="button" className="quiet" style={{ alignSelf: "flex-start", margin: "6px 0 12px" }} onClick={() => setShowAdvanced(!showAdvanced)}>{showAdvanced ? "Hide Advanced Security Options" : "Show Advanced Security Options"}</button>
      {showAdvanced && <div style={{ display: "grid", gap: "10px", padding: "12px", background: "rgba(0,0,0,0.02)", borderRadius: "8px", border: "1px dashed var(--line)" }}>
        <small style={{ color: "var(--muted)" }}>mTLS Client Certificate fields (Optional for high-security enterprise networks):</small>
        <label>mTLS certificate path<input placeholder="C:\\ProgramData\\FileFinder Agent\\client.crt.pem" value={form.certificatePath} onChange={(event) => field("certificatePath", event.target.value)} /></label>
        <label>mTLS private key path<input placeholder="C:\\ProgramData\\FileFinder Agent\\client.key.pem" value={form.privateKeyPath} onChange={(event) => field("privateKeyPath", event.target.value)} /></label>
        <label>Certificate SHA-256 fingerprint<input pattern="[A-Fa-f0-9:]{64,95}" value={form.certificateFingerprint} onChange={(event) => field("certificateFingerprint", event.target.value)} placeholder="e.g. 4A:8B:12..." /></label>
        <label>Coordinator CA path<input placeholder="C:\\ProgramData\\FileFinder Agent\\coordinator-ca.pem" value={form.coordinatorCaPath} onChange={(event) => field("coordinatorCaPath", event.target.value)} /></label>
      </div>}
      <button className="primary" disabled={busy}>{busy ? "Enrolling..." : "Start indexing"}</button></form>}
    {message && <div className={status?.running ? "notice" : "error"}>{message}</div>}<button className="quiet signout" onClick={async () => { await api.logout(); onSignOut(); }}>Sign out on this computer</button></div>;
}
