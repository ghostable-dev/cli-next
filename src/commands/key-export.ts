import { Command } from 'commander';
import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import { Manifest } from '../support/Manifest.js';
import { loadOrCreateKeys } from '../keys.js';
import { deriveKeys, b64 } from '../crypto.js';
import { SessionService } from '../services/SessionService.js';
import { log } from '../support/logger.js';
import { toErrorMessage } from '../support/errors.js';

export function registerKeyExportCommand(program: Command) {
	program
		.command('key:export')
		.description('Export the master seed (default) or a derived per-environment key')
		.option(
			'--env <ENV>',
			'Export the derived key for a specific environment (instead of the master seed)',
		)
		.action(async (opts: { env?: string }) => {
                        if (!opts.env) {
                                try {
                                        const { masterSeedB64 } = await loadOrCreateKeys();
                                        log.line();
                                        log.text(chalk.bold.cyan('🔑  Master seed'));
                                        log.ok(masterSeedB64);
					log.line();
					log.text(
						chalk.dim(
							'Store this in a team password manager.\n' +
								'Any machine with this seed can derive per-environment keys, but still needs API access to pull data.',
						),
					);
					return;
				} catch (error) {
					log.error(toErrorMessage(error) || 'Failed to load master seed.');
					process.exit(1);
				}
			}

                        let projectId: string, envNames: string[];
			try {
				projectId = Manifest.id();
				envNames = Manifest.environmentNames();
			} catch (error) {
				log.error(toErrorMessage(error) || 'Missing ghostable.yml manifest.');
				process.exit(1);
				return;
			}
			if (!envNames.length) {
				log.error('❌ No environments found in ghostable.yml.');
				process.exit(1);
			}

                        const envName =
                                opts.env && envNames.includes(opts.env)
                                        ? opts.env
					: await select<string>({
							message: 'Which environment key would you like to export?',
							choices: envNames.sort().map((n) => ({ name: n, value: n })),
						});

                        const sess = await new SessionService().load();
                        const orgId = sess?.organizationId;
			if (!orgId) {
				log.error('❌ No organization linked. Run `ghostable login` first.');
				process.exit(1);
			}

                        try {
                                const { masterSeedB64 } = await loadOrCreateKeys();
				const masterSeed = Buffer.from(masterSeedB64.replace(/^b64:/, ''), 'base64');
				const scope = `${orgId}/${projectId}/${envName}`;
				const { encKey } = deriveKeys(masterSeed, scope);

				const exportKey = `base64:${b64(encKey)}`;
				log.line();
				log.text(chalk.bold.cyan(`🔑  Environment key for ${envName}`));
				log.ok(exportKey);
				log.line();
				log.text(
					chalk.dim(
						`Copy this and store it in a password manager.\n` +
							`Anyone with this key can decrypt ${envName} for project ${projectId}, but still requires API access to pull data.`,
					),
				);
			} catch (error) {
				log.error(toErrorMessage(error) || 'Failed to derive environment key.');
				process.exit(1);
			}
		});
}
