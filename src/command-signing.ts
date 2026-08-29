import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

export type CommandPayload = {
  id: string;
  type: "REVEAL_FILE" | "OPEN_FILE";
  expiresAt: string;
  fileId: string;
  rootId: string;
  stableFileId: string;
};

export function commandSigner(privateKeyDerBase64: string) {
  const privateKey = createPrivateKey({ key: Buffer.from(privateKeyDerBase64, "base64"), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  const publicKeyDerBase64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");

  return {
    publicKeyDerBase64,
    sign(payload: CommandPayload) {
      const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const signature = sign(null, Buffer.from(encodedPayload), privateKey).toString("base64url");
      return { payload: encodedPayload, signature };
    }
  };
}

export function verifyCommandEnvelope(publicKeyDerBase64: string, payload: string, signature: string): boolean {
  const publicKey = createPublicKey({ key: Buffer.from(publicKeyDerBase64, "base64"), format: "der", type: "spki" });
  return verify(null, Buffer.from(payload), publicKey, Buffer.from(signature, "base64url"));
}

