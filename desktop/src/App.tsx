import { FormEvent, startTransition, useEffect, useEffectEvent, useState } from "react";
import { CoordinatorApi, type AuditEntry, type Device, type FileResult, type IndexedRoot, type Session, type User } from "./api";
import { agentStatus, configureAgent, isTauri, startAgent, type AgentStatus } from "./agent";

const DEFAULT_COORDINATOR = "https://filefinder.office.local";

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
  const [section, setSection] = useState<"search" | "devices" | "admin" | "settings">("search");
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
          <button className={section === "search" ? "active" : ""} onClick={() => setSection("search")}>Search</button>
          <button className={section === "devices" ? "active" : ""} onClick={() => setSection("devices")}>Computers</button>
          {session.user.role === "ADMIN" && <button className={section === "admin" ? "active" : ""} onClick={() => setSection("admin")}>Administration</button>}
          <button className={section === "settings" ? "active" : ""} onClick={() => setSection("settings")}>Connection</button>
        </nav>
        <div className="rail-foot"><span className="status-dot" />Private network</div>
      </aside>
      <main>
        {section === "search" && <Search api={api} />}
        {section === "devices" && <Devices api={api} isAdmin={session.user.role === "ADMIN"} />}
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
    <div className="eyebrow">SELF-HOSTED WORKSPACE</div><h1>Find it where it lives.</h1>
    <p>Search approved folders across every connected office computer. File contents never leave their device.</p>
    <form onSubmit={submit}>
      <label>Coordinator address<input value={coordinator} onChange={(event) => setCoordinator(event.target.value)} required /></label>
      <label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required /></label>
      <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label>
      {error && <div className="error" role="alert">{error}</div>}
      <button className="primary" disabled={busy}>{busy ? "Connecting..." : "Enter workspace"}</button>
    </form>
  </section><div className="login-aside"><div className="network-map"><span>Main coordinator</span><i /><span>Office PC 01</span><i /><span>Remote PC 02 via VPN</span></div></div></div>;
}

function Search({ api }: { api: CoordinatorApi }) {
  const [query, setQuery] = useState(""); const [items, setItems] = useState<FileResult[]>([]); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function submit(event: FormEvent) { event.preventDefault(); if (!query.trim()) return; setBusy(true); setError(""); try { const result = await api.search(query); startTransition(() => setItems(result.items)); } catch (cause) { setError(cause instanceof Error ? cause.message : "Search failed"); } finally { setBusy(false); } }
  async function reveal(file: FileResult) { try { await api.createCommand(file.id); } catch (cause) { setError(cause instanceof Error ? cause.message : "Reveal failed"); } }
  return <div className="page"><header><div><div className="eyebrow">GLOBAL INDEX</div><h1>Search every computer</h1></div><div className="privacy-note">Metadata only</div></header>
    <form className="search-box" onSubmit={submit}><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filename, extension, or folder..." aria-label="Search files"/><button disabled={busy}>{busy ? "Searching" : "Search"}</button></form>
    {error && <div className="error" role="alert">{error}</div>}
    <div className="result-meta"><span>{items.length ? `${items.length} matches` : "Ready to search"}</span><span>LAN + private VPN</span></div>
    <section className="results">{items.map((file) => <article className="result" key={file.id}><div className="file-icon">{file.extension.slice(0, 4) || "FILE"}</div><div className="file-main"><h2>{file.name}</h2><p>{file.rootPath} / {file.relativePath}</p><div className="file-meta"><span className={`presence ${file.presence.toLowerCase()}`}>{file.presence}</span><span>{file.deviceName}</span><span>{formatSize(file.sizeBytes)}</span><span>{new Date(file.modifiedAt).toLocaleDateString()}</span></div></div><button className="reveal" disabled={file.presence !== "ONLINE"} onClick={() => reveal(file)}>Reveal</button></article>)}</section>
  </div>;
}

function Devices({ api, isAdmin }: { api: CoordinatorApi; isAdmin: boolean }) {
  const [items, setItems] = useState<Device[]>([]); const [roots, setRoots] = useState<IndexedRoot[]>([]); const [error, setError] = useState(""); const [enrolment, setEnrolment] = useState<{ code: string; expiresAt: string } | null>(null);
  const load = useEffectEvent(async () => { try { const [devices, indexedRoots] = await Promise.all([api.devices(), api.roots()]); setItems(devices.items); setRoots(indexedRoots.items); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load devices"); } });
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 30_000); return () => clearInterval(timer); }, []);
  async function pause(device: Device) { await api.updateDevice(device.id, { state: device.state === "PAUSED" ? "ACTIVE" : "PAUSED" }); await load(); }
  async function createCode() { try { setEnrolment(await api.createEnrolment()); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create enrolment"); } }
  async function toggleRoot(root: IndexedRoot) { if (root.enabled && !window.confirm(`Stop indexing ${root.canonicalPath}? Existing metadata will be hidden.`)) return; await api.updateRoot(root.id, !root.enabled); await load(); }
  return <div className="page"><header><div><div className="eyebrow">FLEET</div><h1>Connected computers</h1></div><div className="header-actions"><div className="privacy-note">{items.length} enrolled</div>{isAdmin && <button className="quiet" onClick={createCode}>New computer code</button>}</div></header>{enrolment && <div className="enrolment-code"><span>One-time code</span><strong>{enrolment.code}</strong><small>Expires {new Date(enrolment.expiresAt).toLocaleTimeString()}</small></div>}{error && <div className="error">{error}</div>}<section className="device-grid">{items.map((device) => <article className="device" key={device.id}><div className="device-top"><span className={`device-orb ${device.presence.toLowerCase()}`} /><span className="device-state">{device.presence}</span></div><h2>{device.name}</h2><p>{device.os}</p><dl><div><dt>Last event</dt><dd>#{device.lastSequence}</dd></div><div><dt>Last seen</dt><dd>{device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleTimeString() : "Never"}</dd></div></dl><div className="root-list">{roots.filter((root) => root.deviceId === device.id).map((root) => <button key={root.id} disabled={!isAdmin} onClick={() => toggleRoot(root)}><span>{root.canonicalPath}</span><b>{root.enabled ? "INDEXED" : "DISABLED"}</b></button>)}</div>{isAdmin && device.state !== "REVOKED" && <button className="quiet" onClick={() => pause(device)}>{device.state === "PAUSED" ? "Resume indexing" : "Pause indexing"}</button>}</article>)}</section></div>;
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
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [form, setForm] = useState({ code: "", name: "", rootPath: "", certificatePath: "", privateKeyPath: "", certificateFingerprint: "", coordinatorCaPath: "" });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (isTauri()) void agentStatus().then(setStatus); }, []);
  function field(name: keyof typeof form, value: string) { setForm((current) => ({ ...current, [name]: value })); }
  async function enrol(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
      const publicKey = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey))));
      const enrolled = await api.enrolDevice(form.code, form.name, publicKey, form.certificateFingerprint.replaceAll(":", ""));
      const root = await api.addRoot(enrolled.deviceId, form.rootPath);
      await configureAgent({ coordinatorUrl: coordinator.replace("filefinder.", "agents.filefinder."), agentToken: enrolled.agentToken, commandSigningPublicKey: enrolled.commandSigningPublicKey, clientCertificatePem: form.certificatePath, clientPrivateKeyPem: form.privateKeyPath, coordinatorCaPem: form.coordinatorCaPath, rootId: root.id, rootPath: form.rootPath });
      setStatus(await startAgent()); setMessage("This computer is enrolled and indexing has started.");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "Agent setup failed"); } finally { setBusy(false); }
  }
  return <div className="page narrow"><header><div><div className="eyebrow">NETWORK</div><h1>Connection</h1></div></header><section className="settings-card"><div><span>Coordinator</span><strong>{coordinator}</strong></div><div><span>Access modes</span><strong>Office LAN / Private VPN</strong></div><div><span>Local agent</span><strong>{status?.running ? "Running" : status?.configured ? "Configured" : "Not configured"}</strong></div><div><span>Indexed data</span><strong>Names, paths and metadata only</strong></div><div><span>File transfer</span><strong>Disabled</strong></div></section>
    {isAdmin && isTauri() && !status?.running && <form className="agent-setup" onSubmit={enrol}><div className="eyebrow">ENROL THIS COMPUTER</div><label>One-time enrolment code<input value={form.code} onChange={(event) => field("code", event.target.value)} required /></label><label>Computer name<input value={form.name} onChange={(event) => field("name", event.target.value)} required /></label><label>Approved folder path<input placeholder="D:\\Projects" value={form.rootPath} onChange={(event) => field("rootPath", event.target.value)} required /></label><label>mTLS certificate path<input placeholder="C:\\ProgramData\\FileFinder Agent\\client.crt.pem" value={form.certificatePath} onChange={(event) => field("certificatePath", event.target.value)} required /></label><label>mTLS private key path<input placeholder="C:\\ProgramData\\FileFinder Agent\\client.key.pem" value={form.privateKeyPath} onChange={(event) => field("privateKeyPath", event.target.value)} required /></label><label>Certificate SHA-256 fingerprint<input pattern="[A-Fa-f0-9:]{64,95}" value={form.certificateFingerprint} onChange={(event) => field("certificateFingerprint", event.target.value)} required /></label><label>Coordinator CA path (private CA only)<input placeholder="C:\\ProgramData\\FileFinder Agent\\coordinator-ca.pem" value={form.coordinatorCaPath} onChange={(event) => field("coordinatorCaPath", event.target.value)} /></label><button className="primary" disabled={busy}>{busy ? "Enrolling..." : "Start indexing"}</button></form>}
    {message && <div className={status?.running ? "notice" : "error"}>{message}</div>}<button className="quiet signout" onClick={async () => { await api.logout(); onSignOut(); }}>Sign out on this computer</button></div>;
}
