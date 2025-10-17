import { Command } from 'commander';
import ora from 'ora';
import path from 'node:path';

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
import { log } from '../support/logger.js';
import { toErrorMessage } from '../support/errors.js';
import { resolveWorkDir } from '../support/workdir.js';

import type { EnvironmentSecretBundle } from '@/domain';

export function registerDeployCloudCommand(program: Command) {
	program
		.command('deploy:cloud')
		.description('Deploy Ghostable managed environment variables for Laravel Cloud.')
		.option('--token <TOKEN>', 'Ghostable CI token (or env GHOSTABLE_CI_TOKEN)')
		.option('--out <PATH>', 'Where to write the encrypted blob (default: .env.encrypted)')
		.option('--only <KEY...>', 'Limit to specific keys')
		.action(async (opts: { token?: string; out?: string; only?: string[] }) => {
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

                        const spin = ora('Fetching environment secret bundle…').start();
			let bundle: EnvironmentSecretBundle;
			try {
				bundle = await client.deploy({
					includeMeta: true,
					includeVersions: true,
					only: opts.only,
				});
				spin.succeed('Bundle fetched.');
			} catch (error) {
				spin.fail('Failed to fetch bundle.');
				log.error(toErrorMessage(error));
				process.exit(1);
			}

			if (!bundle.secrets.length) {
				log.warn('No secrets returned; nothing to write.');
				return;
			}

                        const { secrets, warnings } = await decryptBundle(bundle, { masterSeedB64 });
			for (const w of warnings) log.warn(`⚠️ ${w}`);

			const merged: Record<string, string> = {};
			for (const s of secrets) merged[s.entry.name] = s.value;

                        const envPath = path.resolve(resolveWorkDir(), '.env');
			const previousMeta = readEnvFileSafeWithMetadata(envPath);
			const previous = previousMeta.vars;
			const combined = { ...previous, ...merged };
			const preserved = buildPreservedSnapshot(previousMeta, merged);
			writeEnvFile(envPath, combined, { preserve: preserved });
			log.ok(`✅ Wrote ${Object.keys(merged).length} keys → ${envPath}`);

			log.ok('Ghostable 👻 deployed (local).');
		});
}
