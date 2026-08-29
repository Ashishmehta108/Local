import { describe, expect, it } from "vitest";
import { hashSecret, normalizeEmail, normalizeSearch, verifySecret } from "../src/auth.js";

describe("normalization", () => {
  it("normalizes email independently from the system locale", () => {
    expect(normalizeEmail("  ADMIN@EXAMPLE.COM ")).toBe("admin@example.com");
  });

  it("uses NFKC search normalization", () => {
    expect(normalizeSearch("  Report\u00A0FINAL.PDF ")).toBe("report final.pdf");
  });
});

describe("secret hashing", () => {
  it("verifies only the original secret", async () => {
    const encoded = await hashSecret("a sufficiently long secret");
    expect(encoded.startsWith("$argon2id$")).toBe(true);
    await expect(verifySecret("a sufficiently long secret", encoded)).resolves.toBe(true);
    await expect(verifySecret("not the original", encoded)).resolves.toBe(false);
  });
});
