// A stand-in for Electron's safeStorage in tests: the real one (the Keychain)
// is never called. Reversible, and never the plain text.

import type { SecretCipher } from "../../src/main/secret-store";

/** A reversible stand-in for safeStorage: never the plain text on disk. */
export function fakeCipher(available = true, backend?: string): SecretCipher & { calls: number } {
  const cipher = {
    calls: 0,
    isEncryptionAvailable: () => available,
    encryptString(plain: string): Buffer {
      cipher.calls += 1;
      return Buffer.from(`enc:${Buffer.from(plain, "utf8").reverse().toString("hex")}`, "utf8");
    },
    decryptString(encrypted: Buffer): string {
      const text = encrypted.toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
      return Buffer.from(text.slice(4), "hex").reverse().toString("utf8");
    },
    ...(backend === undefined ? {} : { getSelectedStorageBackend: () => backend }),
  };
  return cipher;
}
