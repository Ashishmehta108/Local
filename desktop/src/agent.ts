import { invoke } from "@tauri-apps/api/core";

export type AgentStatus = { configured: boolean; running: boolean };
export type AgentIdentity = { publicKey: string };

type ConfigureAgent = {
  coordinatorUrl: string;
  agentToken: string;
  commandSigningPublicKey: string;
  requireRequestSignatures: boolean;
  requireClientCertificate: boolean;
  clientCertificatePem: string | null;
  clientPrivateKeyPem: string | null;
  coordinatorCaPem: string | null;
  rootId: string;
  rootPath: string;
};

export function isTauri() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function agentStatus(): Promise<AgentStatus> {
  if (!isTauri()) return Promise.resolve({ configured: false, running: false });
  return invoke("agent_status");
}

export function startAgent(): Promise<AgentStatus> {
  if (!isTauri()) return Promise.resolve({ configured: true, running: true });
  return invoke("start_agent");
}

export function createAgentIdentity(): Promise<AgentIdentity> {
  if (!isTauri()) return Promise.resolve({ publicKey: "MCowBQYDK2VwAyEAMockPublicKeyForBrowserTesting12345=" });
  return invoke("create_agent_identity");
}

export function configureAgent(input: ConfigureAgent): Promise<AgentStatus> {
  if (!isTauri()) return Promise.resolve({ configured: true, running: true });
  return invoke("configure_agent", {
    config: {
      coordinatorUrl: input.coordinatorUrl,
      agentToken: input.agentToken,
      protectedAgentToken: null,
      commandSigningPublicKey: input.commandSigningPublicKey,
      requireRequestSignatures: input.requireRequestSignatures,
      protectedDeviceSigningKey: null,
      requireClientCertificate: input.requireClientCertificate,
      clientCertificatePem: input.clientCertificatePem,
      clientPrivateKeyPem: input.clientPrivateKeyPem,
      coordinatorCaPem: input.coordinatorCaPem,
      dataDirectory: "",
      roots: [{ id: input.rootId, path: input.rootPath }],
      batchSize: 500
    }
  });
}
