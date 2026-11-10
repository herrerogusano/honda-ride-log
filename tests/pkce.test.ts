import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { clearPendingLogin, PENDING_LOGIN_TTL_MS, savePendingLogin, takePendingLogin, type StorageLike } from "../src/auth/pendingLogin";
import { base64Url, challengeFor, randomToken, VERIFIER_PATTERN, type CryptoLike } from "../src/auth/pkce";

const crypto = webcrypto as unknown as CryptoLike;

describe("PKCE", () => {
  it("computes the S256 challenge of RFC 7636, appendix B", async () => {
    expect(await challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", crypto)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("makes verifiers of 43 allowed characters from 32 random bytes", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const token = randomToken(crypto);
      expect(token).toMatch(VERIFIER_PATTERN);
      expect(token).toHaveLength(43);
      seen.add(token);
    }
    expect(seen.size).toBe(50);
  });

  it("asks the random source for exactly 32 bytes", () => {
    let asked = 0;
    const counting: CryptoLike = {
      subtle: crypto.subtle,
      getRandomValues: (array) => {
        asked += array.length;
        return crypto.getRandomValues(array);
      },
    };
    randomToken(counting);
    expect(asked).toBe(32);
  });

  it("encodes base64url without padding", () => {
    expect(base64Url(new Uint8Array([251, 255, 191]))).toBe("-_-_");
    expect(base64Url(new Uint8Array([1]))).toBe("AQ");
  });
});

class MemoryStorage implements StorageLike {
  readonly items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

const PENDING = { verifier: "v".repeat(43), state: "s".repeat(43) };

describe("pending login", () => {
  it("is read once: taking it removes it", () => {
    const storage = new MemoryStorage();
    savePendingLogin(storage, PENDING, 1000);
    expect(takePendingLogin(storage, 2000)).toEqual(PENDING);
    expect(storage.items.size).toBe(0);
    expect(takePendingLogin(storage, 2000)).toBeNull();
  });

  it("expires after ten minutes, and is removed anyway", () => {
    const storage = new MemoryStorage();
    savePendingLogin(storage, PENDING, 1000);
    expect(takePendingLogin(storage, 1000 + PENDING_LOGIN_TTL_MS + 1)).toBeNull();
    expect(storage.items.size).toBe(0);
  });

  it("refuses an entry from the future (a clock jump) or one that was tampered with", () => {
    const storage = new MemoryStorage();
    savePendingLogin(storage, PENDING, 5000);
    expect(takePendingLogin(storage, 4000)).toBeNull();
    expect(storage.items.size).toBe(0);
    const tampered = [
      "not json",
      "null",
      JSON.stringify({ ...PENDING, createdAt: "1" }),
      JSON.stringify({ ...PENDING, verifier: "short", createdAt: 1 }),
      JSON.stringify({ ...PENDING, state: "", createdAt: 1 }),
    ];
    for (const text of tampered) {
      storage.items.set("ride-log.pending-login", text);
      expect(takePendingLogin(storage, 1)).toBeNull();
      expect(storage.items.size).toBe(0);
    }
  });

  it("removes the entry even when reading it throws", () => {
    const storage = new MemoryStorage();
    savePendingLogin(storage, PENDING, 1000);
    const broken: StorageLike = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => undefined,
      removeItem: (key) => storage.removeItem(key),
    };
    expect(() => takePendingLogin(broken, 1000)).toThrow("SecurityError");
    expect(storage.items.size).toBe(0);
  });

  it("can be cleared", () => {
    const storage = new MemoryStorage();
    savePendingLogin(storage, PENDING, 1000);
    clearPendingLogin(storage);
    expect(storage.items.size).toBe(0);
  });
});
