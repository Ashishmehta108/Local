export type Session = { accessToken: string; refreshToken: string; user: { id: string; role: "ADMIN" | "MEMBER" } };
export type Device = { id: string; name: string; os: string; state: string; presence: string; lastSeenAt: string | null; lastSequence: string };
export type FileResult = {
  id: string; name: string; relativePath: string; extension: string; sizeBytes: string; modifiedAt: string;
  deviceId: string; deviceName: string; presence: "ONLINE" | "STALE" | "OFFLINE"; rootPath: string;
};
export type EnrolledDevice = { deviceId: string; agentToken: string; commandSigningPublicKey: string };
export type IndexedRoot = { id: string; deviceId: string; canonicalPath: string; enabled: boolean; lastScanAt: string | null };
export type User = { id: string; email: string; role: "ADMIN" | "MEMBER"; createdAt: string };
export type AuditEntry = { id: string; actorType: string; action: string; targetType: string; outcome: string; createdAt: string };

export class CoordinatorApi {
  private session: Session | null;
  constructor(private readonly baseUrl: string, session: Session | null = null, private readonly onSession?: (session: Session) => void) { this.session = session; }

  setAccessToken(token: string) { if (this.session) this.session = { ...this.session, accessToken: token }; }

  async login(email: string, password: string): Promise<Session> {
    const session = await this.request<Session>("/api/v1/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }, false);
    this.session = session;
    return session;
  }

  search(query: string): Promise<{ items: FileResult[] }> {
    return this.request(`/api/v1/files/search?q=${encodeURIComponent(query)}`);
  }

  devices(): Promise<{ items: Device[] }> { return this.request("/api/v1/devices"); }

  enrolDevice(code: string, name: string, publicKey: string, certificateFingerprint?: string): Promise<EnrolledDevice> {
    return this.request("/api/v1/devices/enrol", { method: "POST", body: JSON.stringify({ code, name, os: "Windows", publicKey, ...(certificateFingerprint ? { certificateFingerprint } : {}) }) }, false);
  }

  addRoot(deviceId: string, canonicalPath: string): Promise<{ id: string }> {
    return this.request(`/api/v1/devices/${deviceId}/roots`, { method: "POST", body: JSON.stringify({ canonicalPath }) });
  }

  createEnrolment(expiresInMinutes = 30): Promise<{ id: string; code: string; expiresAt: string }> {
    return this.request("/api/v1/enrolments", { method: "POST", body: JSON.stringify({ expiresInMinutes }) });
  }

  roots(): Promise<{ items: IndexedRoot[] }> { return this.request("/api/v1/indexed-roots"); }
  updateRoot(rootId: string, enabled: boolean) { return this.request(`/api/v1/indexed-roots/${rootId}`, { method: "PATCH", body: JSON.stringify({ enabled }) }); }
  users(): Promise<{ items: User[] }> { return this.request("/api/v1/users"); }
  createUser(email: string, password: string, role: "ADMIN" | "MEMBER") { return this.request<User>("/api/v1/users", { method: "POST", body: JSON.stringify({ email, password, role }) }); }
  audit(): Promise<{ items: AuditEntry[] }> { return this.request("/api/v1/audit?limit=100"); }

  async logout() {
    if (this.session?.refreshToken) await this.request("/api/v1/auth/logout", { method: "POST", body: JSON.stringify({ refreshToken: this.session.refreshToken }) }, false).catch(() => undefined);
  }

  createCommand(fileId: string, type: "REVEAL_FILE" | "OPEN_FILE" = "REVEAL_FILE") {
    return this.request<{ id: string; expiresAt: string }>("/api/v1/commands", { method: "POST", body: JSON.stringify({ fileId, type }) });
  }

  updateDevice(deviceId: string, update: { name?: string; state?: "ACTIVE" | "PAUSED" | "REVOKED" }) {
    return this.request(`/api/v1/devices/${deviceId}`, { method: "PATCH", body: JSON.stringify(update) });
  }

  async request<T>(path: string, init: RequestInit = {}, authenticated = true, allowRefresh = true): Promise<T> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(authenticated && this.session?.accessToken ? { authorization: `Bearer ${this.session.accessToken}` } : {}), ...init.headers }
    });
    if (response.status === 401 && authenticated && allowRefresh && this.session?.refreshToken) {
      const renewed = await this.request<Session>("/api/v1/auth/refresh", { method: "POST", body: JSON.stringify({ refreshToken: this.session.refreshToken }) }, false, false);
      this.session = renewed; this.onSession?.(renewed);
      return this.request<T>(path, init, authenticated, false);
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: { message?: string } };
      throw new Error(body.error?.message ?? `Coordinator returned ${response.status}`);
    }
    return response.status === 204 ? undefined as T : response.json() as Promise<T>;
  }
}
