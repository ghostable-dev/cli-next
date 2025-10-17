import { Command } from 'commander';
import ora from 'ora';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
	writeEnvFile,
	readEnvFileSafeWithMetadata,
	buildPreservedSnapshot,
} from '../support/env-files.js';
import {
	createGhostableClient,
	decryptBundle,
	resolveDeployMasterSeed,
	resolveToken,
} from '../support/deploy-helpers.js';
import { vapor } from '../support/vapor.js';
import { log } from '../support/logger.js';
import { toErrorMessage } from '../support/errors.js';
import { resolveWorkDir } from '../support/workdir.js';

import type { EnvironmentSecret, EnvironmentSecretBundle } from '@/domain';

export function registerDeployVaporCommand(program: Command) {
	program
		.command('deploy:vapor')
		.description('Deploy Ghostable managed environment variables for Laravel Vapor.')
		.option('--token <TOKEN>', 'Ghostable CI token (or env GHOSTABLE_CI_TOKEN)')
		.option('--vapor-env <ENV>', 'Target Vapor environment')
		.option('--only <KEY...>', 'Limit to specific keys')
		.action(async (opts: { token?: string; vaporEnv?: string; only?: string[] }) => {
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
				log.warn('No secrets returned; nothing to deploy.');
				return;
			}

                        const { secrets, warnings } = await decryptBundle(bundle, { masterSeedB64 });
			for (const w of warnings) log.warn(`⚠️ ${w}`);

			if (!secrets.length) {
				log.warn('No decryptable secrets; nothing to deploy.');
				return;
			}

			const vaporEnv = (opts.vaporEnv ?? '').trim();
			if (!vaporEnv) {
				log.error('❌ The --vapor-env option is required when deploying to Vapor.');
				process.exit(1);
			}

			if (!vapor.exists()) {
				log.error('❌ vapor CLI not found on PATH');
				process.exit(1);
			}

			const standardVars: Record<string, string> = {};
			const secretVars: Record<string, string> = {};

			for (const s of secrets) {
				const entry = s.entry as EnvironmentSecret;
				if (entry.meta?.is_vapor_secret) {
					secretVars[entry.name] = s.value;
				} else {
					standardVars[entry.name] = s.value;
				}
			}

			try {
				await deployStandardVariables(vaporEnv, standardVars);
			} catch (error) {
				log.error(toErrorMessage(error));
				process.exit(1);
			}

			try {
				await deploySecretVariables(vaporEnv, secretVars);
			} catch (error) {
				log.error(toErrorMessage(error));
				process.exit(1);
			}

			log.ok(`Vapor environment "${vaporEnv}" updated.`);
		});
}

async function deployStandardVariables(
	vaporEnv: string,
	variables: Record<string, string>,
): Promise<void> {
	const count = Object.keys(variables).length;
	log.info(`Deploying (${count}) standard variables to Vapor env "${vaporEnv}"`);

	if (!count) {
		log.warn('No standard variables to deploy.');
		return;
	}

	log.info(`Pulling existing environment "${vaporEnv}" from Vapor`);
	vapor.ensureSuccess(vapor.tryRun(['env:pull', vaporEnv]), `pull environment "${vaporEnv}"`);

	const envPath = path.resolve(resolveWorkDir(), `.env.${vaporEnv}`);
	const existingMeta = readEnvFileSafeWithMetadata(envPath);
	const existing = existingMeta.vars;
	const merged = { ...existing, ...variables };
	const preserved = buildPreservedSnapshot(existingMeta, variables);
	writeEnvFile(envPath, merged, { preserve: preserved });

	log.info(`Pushing updated environment "${vaporEnv}" to Vapor`);
	vapor.ensureSuccess(vapor.tryRun(['env:push', vaporEnv]), `push environment "${vaporEnv}"`);
}

async function deploySecretVariables(
	vaporEnv: string,
	variables: Record<string, string>,
): Promise<void> {
	const entries = Object.entries(variables);
	log.info(`Deploying (${entries.length}) secret variables to Vapor env "${vaporEnv}"`);

	if (!entries.length) {
		log.warn('No secret variables to deploy.');
		return;
	}

	let failures = 0;
	for (const [key, value] of entries) {
		let filePath: string | undefined;
		try {
			filePath = await createSecretTempFile(value);
			const result = vapor.tryRun(['secret', vaporEnv, `--name=${key}`, '--file', filePath]);

			if (result.status === 0) {
				log.ok(`[OK]   ${key}`);
			} else {
				failures++;
				const message = vapor._extractProcessError(result);
				log.error(`[ERR]  ${key} → ${message}`);
			}
		} catch (error) {
			failures++;
			log.error(`[ERR]  ${key} → ${toErrorMessage(error)}`);
		} finally {
			if (filePath) safeUnlink(filePath);
		}
	}

	if (failures > 0) {
		throw new Error(`Vapor secret deployment completed with ${failures} failure(s).`);
	}

	log.ok('Vapor secret deployment completed successfully.');
}

function createSecretTempFile(value: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const dir = os.tmpdir();
		const name = `ghostable-secret-${crypto.randomBytes(6).toString('hex')}`;
		const filePath = path.join(dir, name);

		try {
			fs.writeFileSync(filePath, value, {
				encoding: 'utf8',
				mode: 0o600,
				flag: 'w',
			});
			fs.chmodSync(filePath, 0o600);
			resolve(filePath);
		} catch {
			safeUnlink(filePath);
			reject(new Error('Failed to write secret to temp file.'));
		}
	});
}

function safeUnlink(filePath: string): void {
        try {
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch {
        }
}
