/**
 * Passphrase-based AES-256-GCM sealing, shared by the search-index file and the
 * registry's stored secrets (vault passphrases, CouchDB passwords).
 * Format: salt:iv:tag:ciphertext, all hex. scrypt makes each call ~tens of ms,
 * so callers should cache decrypted values rather than open on a hot path.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

export function seal(text: string, passphrase: string): string {
    const salt = randomBytes(16);
    const key = scryptSync(passphrase, salt, 32);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(text, "utf-8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return salt.toString("hex") + ":" + iv.toString("hex") + ":" + tag.toString("hex") + ":" + encrypted.toString("hex");
}

export function open(data: string, passphrase: string): string {
    const [saltHex, ivHex, tagHex, encryptedHex] = data.split(":");
    const key = scryptSync(passphrase, Buffer.from(saltHex, "hex"), 32);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(encryptedHex, "hex")), decipher.final()]).toString("utf-8");
}
