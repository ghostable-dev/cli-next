import { randomBytes, b64 } from './crypto.js';
import { loadKeytar } from './support/keyring.js';

const SERVICE = 'ghostable-cli';
const DEFAULT_PROFILE = 'default';

export type KeyBundle = {
        masterSeedB64: string;
        ed25519PrivB64: string;
        ed25519PubB64: string;
};

function ub64Prefixed(s: string): Uint8Array {
	const clean = s.replace(/^b64:|^base64:/, '');
	return new Uint8Array(Buffer.from(clean, 'base64'));
}
function b64Prefixed(bytes: Uint8Array): string {
	return `b64:${b64(bytes)}`;
}

/** Persist a bundle to the OS keychain for a given profile. */
export async function saveKeys(bundle: KeyBundle, profile = DEFAULT_PROFILE): Promise<void> {
	const keytar = await loadKeytar();
	if (!keytar) {
		throw new Error('OS keychain is disabled in this context. Use token/env in deploy flows.');
	}
	await keytar.setPassword(SERVICE, profile, JSON.stringify(bundle));
}

/** Load the bundle for a profile, or create & persist a new one if missing. */
export async function loadOrCreateKeys(profile = DEFAULT_PROFILE): Promise<KeyBundle> {
	const keytar = await loadKeytar();
	if (!keytar) {
		throw new Error(
			'OS keychain is disabled in this context. For deploy, provide a seed/token via env.',
		);
	}

	const existing = await keytar.getPassword(SERVICE, profile);
	if (existing) return JSON.parse(existing) as KeyBundle;

	const masterSeed = randomBytes(32);
	const edSeed = randomBytes(32);
	const pub = await (await import('@noble/ed25519')).getPublicKey(edSeed);

	const bundle: KeyBundle = {
		masterSeedB64: b64Prefixed(masterSeed),
		ed25519PrivB64: b64Prefixed(edSeed),
		ed25519PubB64: b64Prefixed(pub),
	};
	await saveKeys(bundle, profile);
	return bundle;
}

export function getSeed(bundle: KeyBundle): Uint8Array {
	return ub64Prefixed(bundle.masterSeedB64);
}
export function getPriv(bundle: KeyBundle): Uint8Array {
	return ub64Prefixed(bundle.ed25519PrivB64);
}
export function getPub(bundle: KeyBundle): Uint8Array {
	return ub64Prefixed(bundle.ed25519PubB64);
}

/** Update only the master seed while preserving signing keys. */
export async function setMasterSeed(seedB64: string, profile = DEFAULT_PROFILE): Promise<void> {
	const normalized =
		seedB64.startsWith('b64:') || seedB64.startsWith('base64:')
			? seedB64.replace(/^base64:/, 'b64:')
			: `b64:${seedB64}`;

        const bundle = await loadOrCreateKeys(profile);
	const updated: KeyBundle = { ...bundle, masterSeedB64: normalized };
	await saveKeys(updated, profile);
}
