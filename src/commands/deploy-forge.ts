import { Command } from 'commander';
import ora from 'ora';
import path from 'node:path';
import fs from 'node:fs';

import { b64, randomBytes } from '../crypto.js';
import {
	writeEnvFile,
	readEnvFileSafeWithMetadata,
	buildPreservedSnapshot,
} from '../support/env-files.js';
import { artisan } from '../support/artisan.js';
import {
	createGhostableClient,
	decryptBundle,
	resolveDeployMasterSeed,
	resolveToken,
} from '../support/deploy-helpers.js';
import { log } from '../support/logger.js';
import { toErrorMessage } from '../support/errors.js';
import { resolveWorkDir } from '../support/workdir.js';
import type { EnvironmentSecretBundle } from '@/domain';

export function registerDeployForgeCommand(program: Command) {
	program
		.command('deploy:forge')
		.description('Deploy Ghostable managed environment variables for Laravel Forge.')
		.option('--token <TOKEN>', 'Ghostable CI token (or env GHOSTABLE_CI_TOKEN)')
		.option('--encrypted', 'Also produce an encrypted blob via php artisan env:encrypt', false)
		.option('--out <PATH>', 'Where to write the encrypted blob (default: .env.encrypted)')
		.option('--only <KEY...>', 'Limit to specific keys')
		.action(
			async (opts: {
				token?: string;
				encrypted?: boolean;
				out?: string;
				only?: string[];
			}) => {
				let masterSeedB64: string;
				try {
					masterSeedB64 = resolveDeployMasterSeed();
				} catch (error) {
					log.error(toErrorMessage(error));
					process.exit(1);
				}

                                let token: string;
				try {
					token = await resolveToken(opts.token, { allowSession: false });
				} catch (error) {
					log.error(toErrorMessage(error));
					process.exit(1);
				}
				const client = createGhostableClient(token);

                                const deploySpin = ora('Fetching environment secret bundle…').start();
				let bundle: EnvironmentSecretBundle;
				try {
					bundle = await client.deploy({
						includeMeta: true,
						includeVersions: true,
						only: opts.only,
					});
					deploySpin.succeed('Bundle fetched.');
				} catch (error) {
					deploySpin.fail('Failed to fetch bundle.');
					log.error(toErrorMessage(error));
					process.exit(1);
				}

				if (!bundle.secrets.length) {
					log.warn('No secrets returned; nothing to write.');
					return;
				}

                                const { secrets, warnings } = await decryptBundle(bundle, {
                                        masterSeedB64,
                                });
				for (const warning of warnings) log.warn(`⚠️ ${warning}`);

				const merged: Record<string, string> = {};
				for (const s of secrets) merged[s.entry.name] = s.value;

                                const workDir = resolveWorkDir();
				const envPath = path.resolve(workDir, '.env');
				const previousMeta = readEnvFileSafeWithMetadata(envPath);
				const previous = previousMeta.vars;
				const combined = { ...previous, ...merged };
				const preserved = buildPreservedSnapshot(previousMeta, merged);

				writeEnvFile(envPath, combined, { preserve: preserved });
				log.ok(`✅ Wrote ${Object.keys(merged).length} keys → ${envPath}`);

                                if (opts.encrypted) {
                                        if (!artisan.exists()) {
                                                log.error('❌ php or artisan not found. Run inside a Laravel project.');
						process.exit(1);
					}

					const cwd = workDir;
					const outFile = path.resolve(cwd, opts.out ?? `.env.encrypted`);

					const envKeyB64 = `base64:${b64(randomBytes(32))}`;

                                        combined['LARAVEL_ENV_ENCRYPTION_KEY'] = envKeyB64;
                                        writeEnvFile(envPath, combined, { preserve: preserved });
                                        log.ok(`🔑 Set LARAVEL_ENV_ENCRYPTION_KEY in ${path.basename(envPath)}`);

                                        const encSpin = ora('Encrypting .env via php artisan env:encrypt…').start();
					try {
						artisan.run(['env:encrypt', `--key=${envKeyB64}`]);
						encSpin.succeed('Encrypted .env created via Artisan.');
					} catch (err) {
						encSpin.fail('Artisan encryption failed.');
						log.error(err instanceof Error ? err.message : String(err));
						process.exit(1);
					}

					const produced = path.join(cwd, '.env.encrypted');
					if (!fs.existsSync(produced)) {
						encSpin.fail('Expected .env.encrypted not found.');
						process.exit(1);
					}

					fs.renameSync(produced, outFile);
					encSpin.succeed(`Encrypted blob → ${path.relative(cwd, outFile)}`);
				}

				log.ok('Ghostable 👻 deployed (local).');
			},
		);
}
