import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
// Reference implementation already used by happy-agent against real app data.
import { deriveContentKeyPair, decryptBoxBundle } from '../../../../../happy-agent/src/encryption';
import {
    boxForRecipient,
    cliKeyBundlePlaintext,
    decodeEphemeralPublicKey,
    deriveAccountPublicKeyHex,
    deriveContentPublicKey,
    generateRootSecret,
} from './accountKeys';

const fixedSecret = new Uint8Array(32).map((_, i) => i);

describe('accountKeys', () => {
    it('generates 32 random bytes', () => {
        const a = generateRootSecret();
        const b = generateRootSecret();
        expect(a).toHaveLength(32);
        expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    });

    it('derives the same content public key as the client implementation', () => {
        expect(Buffer.from(deriveContentPublicKey(fixedSecret)).toString('hex'))
            .toBe(Buffer.from(deriveContentKeyPair(fixedSecret).publicKey).toString('hex'));
    });

    it('derives the account public key the way legacy /v1/auth stored it', () => {
        const expected = privacyKit.encodeHex(new Uint8Array(tweetnacl.sign.keyPair.fromSeed(fixedSecret).publicKey));
        expect(deriveAccountPublicKeyHex(fixedSecret)).toBe(expected);
    });

    it('builds the CLI bundle as [0 | contentPublicKey]', () => {
        const bundle = cliKeyBundlePlaintext(fixedSecret);
        expect(bundle).toHaveLength(33);
        expect(bundle[0]).toBe(0);
        expect(Buffer.from(bundle.slice(1)).equals(Buffer.from(deriveContentPublicKey(fixedSecret)))).toBe(true);
    });

    it('boxes data so the client box-bundle decoder can open it', () => {
        const recipient = tweetnacl.box.keyPair();
        const boxed = boxForRecipient(fixedSecret, recipient.publicKey);
        expect(boxed.length).toBe(32 + 24 + 32 + 16);
        const opened = decryptBoxBundle(boxed, recipient.secretKey);
        expect(opened && Buffer.from(opened).equals(Buffer.from(fixedSecret))).toBe(true);
    });

    it('accepts only 32-byte ephemeral public keys', () => {
        expect(decodeEphemeralPublicKey(privacyKit.encodeBase64(new Uint8Array(32)))).toHaveLength(32);
        expect(decodeEphemeralPublicKey(privacyKit.encodeBase64(new Uint8Array(31)))).toBeNull();
        expect(decodeEphemeralPublicKey('%%%not-base64%%%')).toBeNull();
    });
});
