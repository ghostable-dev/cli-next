import { Command } from 'commander';
import { input } from '@inquirer/prompts';
import chalk from 'chalk';
import { log } from '../support/logger.js';
import { toErrorMessage } from '../support/errors.js';
import { setMasterSeed } from '../keys.js';

export function registerKeySetCommand(program: Command) {
	program
		.command('key:set')
		.description('Set the master seed used to derive per-environment keys')
		.action(async () => {
			try {
				const raw = await input({
					message: 'Paste the master seed (base64:...):',
					validate: (v) =>
						/^((b64|base64):)?[A-Za-z0-9+/=]+$/.test(v.trim()) ||
						'Expected format: base64:...',
				});

                                await setMasterSeed(raw.trim());

				log.line();
				log.ok('✅ Master seed updated.');
				log.text(
					chalk.dim(
						'New workstations can now derive the same per-environment keys from this seed.\n' +
							'Note: API permissions still gate who can pull any environment.',
					),
				);
			} catch (error) {
				log.error(toErrorMessage(error) || 'Failed to set master seed.');
				process.exit(1);
			}
		});
}
