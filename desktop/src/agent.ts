import { invoke } from "@tauri-apps/api/core";

export type AgentStatus = { configured: boolean; running: boolean };

type ConfigureAgent = {
  coordinatorUrl: string;
  agentToken: string;
  commandSigningPublicKey: string;
  clientCertificatePem: string;
  clientPrivateKeyPem: string;
  coordinatorCaPem: string;
  rootId: string;
  rootPath: string;
};

export function isTauri() {
  return "__TAURI_INTERNALS__" in window;
}

export function agentStatus(): Promise<AgentStatus> {
  return invoke("agent_status");
}

export function startAgent(): Promise<AgentStatus> {
  return invoke("start_agent");
}

export function configureAgent(input: ConfigureAgent): Promise<AgentStatus> {
  return invoke("configure_agent", {
    config: {
      coordinatorUrl: input.coordinatorUrl,
      agentToken: input.agentToken,
      protectedAgentToken: null,
      commandSigningPublicKey: input.commandSigningPublicKey,
      clientCertificatePem: input.clientCertificatePem,
      clientPrivateKeyPem: input.clientPrivateKeyPem,
      coordinatorCaPem: input.coordinatorCaPem || null,
      dataDirectory: "",
      roots: [{ id: input.rootId, path: input.rootPath }],
      batchSize: 500
    }
  });
}
