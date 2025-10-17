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

type EnvDeployOptions = {
        token?: string;
        file?: string;
        only?: string[];
};

export function registerEnvDeployCommand(program: Command) {
	program
		.command('env:deploy')
		.description('Fetch Ghostable env vars and write a local .env file (provider-agnostic).')
		.option('--token <TOKEN>', 'Ghostable CI token (or env GHOSTABLE_CI_TOKEN)')
		.option('--file <PATH>', 'Output file (default: .env)')
		.option('--only <KEY...>', 'Only include these keys')
		.action(async (opts: EnvDeployOptions) => {
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

                        const workDir = resolveWorkDir();
			const outPath = path.resolve(workDir, opts.file ?? '.env');
			const previousMeta = readEnvFileSafeWithMetadata(outPath);
			const previous = previousMeta.vars;
			const combined = { ...previous, ...merged };
			const preserved = buildPreservedSnapshot(previousMeta, merged);

			writeEnvFile(outPath, combined, { preserve: preserved });
			log.ok(`✅ Wrote ${Object.keys(merged).length} keys → ${outPath}`);
			log.ok('Ghostable 👻 deployed (local).');
		});
}
