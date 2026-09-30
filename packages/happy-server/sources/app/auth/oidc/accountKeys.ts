import { createHash, createHmac, randomBytes } from 'crypto';
import tweetnacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';

export function generateRootSecret(): Uint8Array {
    return new Uint8Array(randomBytes(32));
}

/** Same value legacy `/v1/auth` stored in Account.publicKey (Ed25519 key from the secret). */
export function deriveAccountPublicKeyHex(rootSecret: Uint8Array): string {
    return privacyKit.encodeHex(new Uint8Array(tweetnacl.sign.keyPair.fromSeed(rootSecret).publicKey));
}

function hmacSha512(key: Uint8Array, data: Uint8Array): Uint8Array {
    return new Uint8Array(createHmac('sha512', key).update(data).digest());
}

// Mirrors happy-app sources/encryption/deriveKey.ts
function deriveKey(master: Uint8Array, usage: string, path: string[]): Uint8Array {
    let I = hmacSha512(new TextEncoder().encode(usage + ' Master Seed'), master);
    let chainCode = I.slice(32);
    let key = I.slice(0, 32);
    for (const index of path) {
        I = hmacSha512(chainCode, new Uint8Array([0x00, ...new TextEncoder().encode(index)]));
        key = I.slice(0, 32);
        chainCode = I.slice(32);
    }
    return key;
}

export function deriveContentPublicKey(rootSecret: Uint8Array): Uint8Array {
    const seed = deriveKey(rootSecret, 'Happy EnCoder', ['content']);
    // libsodium crypto_box_seed_keypair uses SHA-512(seed)[0:32] as the secret key
    const boxSecretKey = new Uint8Array(createHash('sha512').update(seed).digest()).slice(0, 32);
    return tweetnacl.box.keyPair.fromSecretKey(boxSecretKey).publicKey;
}

/** Plaintext of the v2 terminal pairing response: [0 | contentPublicKey]. */
export function cliKeyBundlePlaintext(rootSecret: Uint8Array): Uint8Array {
    const bundle = new Uint8Array(33);
    bundle[0] = 0;
    bundle.set(deriveContentPublicKey(rootSecret), 1);
    return bundle;
}

/** [ephemeralPublicKey(32) | nonce(24) | box] — the format clients decrypt with decryptWithEphemeralKey. */
export function boxForRecipient(data: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
    const ephemeral = tweetnacl.box.keyPair();
    const nonce = new Uint8Array(randomBytes(tweetnacl.box.nonceLength));
    const encrypted = tweetnacl.box(data, nonce, recipientPublicKey, ephemeral.secretKey);
    const result = new Uint8Array(32 + nonce.length + encrypted.length);
    result.set(ephemeral.publicKey, 0);
    result.set(nonce, 32);
    result.set(encrypted, 32 + nonce.length);
    return result;
}

export function decodeEphemeralPublicKey(base64: string): Uint8Array | null {
    try {
        const bytes = privacyKit.decodeBase64(base64);
        return bytes.length === 32 ? new Uint8Array(bytes) : null;
    } catch {
        return null;
    }
}
