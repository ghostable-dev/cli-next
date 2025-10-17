import { XChaCha20Poly1305 } from '@stablelib/xchacha20poly1305';
import { randomBytes as stableRandom } from '@stablelib/random';
import * as ed from '@noble/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { hmac as nobleHmac } from '@noble/hashes/hmac';
import { randomBytes as nobleRandom } from '@noble/hashes/utils';
import { CIPHER_ALG } from '@/types';
import type { AAD, CipherBundle } from '@/types';

ed.etc.sha512Sync = (m: Uint8Array) => sha512(m);
ed.etc.randomBytes = nobleRandom;

export async function initSodium() {
        return;
}

export function randomBytes(n = 32): Uint8Array {
	return stableRandom(n);
}

export function b64(u8: Uint8Array) {
	return Buffer.from(u8).toString('base64');
}

export function ub64(s: string) {
	return new Uint8Array(Buffer.from(s.replace(/^b64:/, ''), 'base64'));
}

/** Canonicalize AAD JSON order so encrypt/decrypt bytes always match */
function aadBytes(aad: AAD): Uint8Array {
	const canonical = {
		org: aad.org,
		project: aad.project,
		env: aad.env,
		name: aad.name,
	};
	return new TextEncoder().encode(JSON.stringify(canonical));
}

/** Build HKDF scope string from AAD (source of truth for key derivation) */
export function scopeFromAAD(aad: AAD): string {
	return `${aad.org}/${aad.project}/${aad.env}`;
}

/** Encrypt plaintext with XChaCha20-Poly1305, binding canonical AAD. */
export function aeadEncrypt(key: Uint8Array, plaintext: Uint8Array, aad: AAD): CipherBundle {
	const aead = new XChaCha20Poly1305(key);
	const nonce = randomBytes(24);
	const ad = aadBytes(aad);
	const ct = aead.seal(nonce, plaintext, ad);
	return {
		alg: CIPHER_ALG,
		nonce: `b64:${b64(nonce)}`,
		ciphertext: `b64:${b64(ct)}`,
		aad,
	};
}

/** Decrypt (fails if key/nonce/AAD mismatch). */
export function aeadDecrypt(key: Uint8Array, bundle: CipherBundle): Uint8Array {
	const aead = new XChaCha20Poly1305(key);
        const ad = aadBytes(bundle.aad);
	const nonce = ub64(bundle.nonce);
	const ct = ub64(bundle.ciphertext);
	const pt = aead.open(nonce, ct, ad);
	if (!pt) throw new Error('Decryption failed (bad key/nonce/AAD).');
	return pt;
}

/** Deterministic HMAC for drift/equality checks. (Scoped key!) */
export function hmacSHA256(secretKey: Uint8Array, message: Uint8Array): string {
	const mac = nobleHmac(sha256, secretKey, message);
	return `b64:${b64(mac)}`;
}

/** Derive separate ENC and HMAC keys from one master seed (via HKDF). */
export function deriveKeys(masterKey: Uint8Array, ctx: string) {
	const salt = new TextEncoder().encode(`ghostable:${ctx}`);
	const okm = hkdf(sha256, masterKey, salt, new Uint8Array([]), 64);
	const encKey = okm.slice(0, 32);
	const hmacKey = okm.slice(32, 64);
	return { encKey, hmacKey };
}

/** Ed25519 sign/verify for claims payloads. */
export async function edSign(priv: Uint8Array, bytes: Uint8Array) {
	return await ed.sign(bytes, priv);
}

export async function edVerify(pub: Uint8Array, bytes: Uint8Array, sig: Uint8Array) {
	return await ed.verify(sig, bytes, pub);
}
