import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { commandSigner, verifyCommandEnvelope } from "../src/command-signing.js";

describe("command signatures", () => {
  it("accepts an unchanged envelope and rejects tampering", () => {
    const privateKey = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    const signer = commandSigner(privateKey);
    const envelope = signer.sign({
      id: "0198fbe3-087d-7000-8000-000000000001",
      type: "REVEAL_FILE",
      expiresAt: "2026-08-29T12:00:00.000Z",
      fileId: "0198fbe3-087d-7000-8000-000000000002",
      rootId: "0198fbe3-087d-7000-8000-000000000003",
      stableFileId: "volume:file"
    });

    expect(verifyCommandEnvelope(signer.publicKeyDerBase64, envelope.payload, envelope.signature)).toBe(true);
    expect(verifyCommandEnvelope(signer.publicKeyDerBase64, `${envelope.payload}x`, envelope.signature)).toBe(false);
  });
});

