import { config } from '../config/index.js';
import type { Session } from '@/types';
import { loadKeytar } from '../support/keyring.js';

export class SessionService {
	async load(): Promise<Session | null> {
                const keytar = await loadKeytar();
                if (!keytar) return null;
		const raw = await keytar.getPassword(config.keychainService, config.keychainAccount);
		return raw ? (JSON.parse(raw) as Session) : null;
	}

	async save(sess: Session): Promise<void> {
		const keytar = await loadKeytar();
		if (!keytar) {
			throw new Error(
				'OS keychain is disabled in this context. Use token/env in deploy flows.',
			);
		}
		await keytar.setPassword(
			config.keychainService,
			config.keychainAccount,
			JSON.stringify(sess),
		);
	}

	async clear(): Promise<void> {
                const keytar = await loadKeytar();
                if (!keytar) return;
		await keytar.deletePassword(config.keychainService, config.keychainAccount);
	}
}
