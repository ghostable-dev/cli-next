import { Command } from 'commander';
import { select } from '@inquirer/prompts';
import { Listr, ListrTaskWrapper, ListrDefaultRenderer, ListrSimpleRenderer } from 'listr2';
import fs from 'node:fs';
import chalk from 'chalk';

import { initSodium } from '../crypto.js';
import { loadOrCreateKeys } from '../keys.js';
import { config } from '../config/index.js';
import { SessionService } from '../services/SessionService.js';
import { GhostableClient } from '../services/GhostableClient.js';
import { Manifest } from '../support/Manifest.js';
import { log } from '../support/logger.js';
import { toErrorMessage } from '../support/errors.js';
import { getIgnoredKeys, filterIgnoredKeys } from '../support/ignore.js';
import {
	EnvVarSnapshot,
	resolveEnvFile,
	readEnvFileSafeWithMetadata,
} from '../support/env-files.js';
import { buildSecretPayload } from '../support/secret-payload.js';

import type { SignedEnvironmentSecretUploadRequest, ValidatorRecord } from '@/types';

type Ctx = Record<string, unknown>;

export type PushOptions = {
	api?: string;
	token?: string;
        file?: string;
        env?: string;
	assumeYes?: boolean;
	sync?: boolean;
	replace?: boolean;
	pruneServer?: boolean;
};

function resolvePlaintext(parsed: string, snapshot?: EnvVarSnapshot): string {
	if (!snapshot) return parsed;

	const trimmed = snapshot.rawValue.trim();
	if (trimmed.length < 2) return parsed;

	const first = trimmed[0];
	if (first !== '"' && first !== "'") return parsed;
	if (trimmed[trimmed.length - 1] !== first) return parsed;

	return trimmed;
}

export function registerEnvPushCommand(program: Command) {
	program
		.command('env:push')
		.description('Encrypt and push a local .env file to Ghostable (uses ghostable.yml)')
		.option('--file <PATH>', 'Path to .env file (default: .env.<env> or .env)')
		.option('--env <ENV>', 'Environment name (if omitted, select from manifest)')
		.option('-y, --assume-yes', 'Skip confirmation prompts', false)
		.option('--sync', 'Prune server variables not present locally', false)
		.option('--replace', 'Alias for --sync', false)
		.option('--prune-server', 'Alias for --sync', false)
		.action(async (opts: PushOptions) => runEnvPush(opts));
}

export async function runEnvPush(opts: PushOptions): Promise<void> {
        let projectId: string, projectName: string, manifestEnvs: string[];
	try {
		projectId = Manifest.id();
		projectName = Manifest.name();
		manifestEnvs = Manifest.environmentNames();
	} catch (error) {
		log.error(toErrorMessage(error));
		process.exit(1);
		return;
	}
	if (!manifestEnvs.length) {
		log.error('❌ No environments defined in ghostable.yml.');
		process.exit(1);
	}

        let envName = opts.env;
	if (!envName) {
		envName = await select({
			message: 'Which environment would you like to push?',
			choices: manifestEnvs.sort().map((n) => ({ name: n, value: n })),
		});
	}

        const sessionSvc = new SessionService();
	const sess = await sessionSvc.load();
	if (!sess?.accessToken) {
		log.error('❌ No API token. Run `ghostable login`.');
		process.exit(1);
	}
	const token = sess.accessToken;
	const orgId = sess.organizationId;

        const filePath = resolveEnvFile(envName!, opts.file, true);
	if (!fs.existsSync(filePath)) {
		log.error(`❌ .env file not found at ${filePath}`);
		process.exit(1);
	}

        const { vars: envMap, snapshots } = readEnvFileSafeWithMetadata(filePath);
	const ignored = getIgnoredKeys(envName);
	const filteredVars = filterIgnoredKeys(envMap, ignored);
	const sync = Boolean(opts.sync || opts.replace || opts.pruneServer);

	const entries = Object.entries(filteredVars).map(([name, parsedValue]) => ({
		name,
		parsedValue,
		plaintext: resolvePlaintext(parsedValue, snapshots[name]),
	}));
	if (!entries.length) {
		log.warn('⚠️  No variables found in the .env file.');
		return;
	}

	if (!opts.assumeYes) {
		log.info(
			`About to push ${entries.length} variables from ${chalk.bold(filePath)}\n` +
				`→ project ${chalk.bold(projectName)} (${projectId})\n` +
				(orgId ? `→ org ${chalk.bold(orgId)}\n` : ''),
		);
	}

        await initSodium();
	const keyBundle = await loadOrCreateKeys();
	const masterSeed = Buffer.from(keyBundle.masterSeedB64.replace(/^b64:/, ''), 'base64');
	const edPriv = Buffer.from(keyBundle.ed25519PrivB64.replace(/^b64:/, ''), 'base64');

	const client = GhostableClient.unauthenticated(config.apiBase).withToken(token);

        const payloads: SignedEnvironmentSecretUploadRequest[] = [];

	const tasks = new Listr<Ctx, ListrDefaultRenderer, ListrSimpleRenderer>(
		[
			...entries.map(({ name, parsedValue, plaintext }) => ({
				title: `${name}`,
				task: async (
					_ctx: Ctx,
					task: ListrTaskWrapper<Ctx, ListrDefaultRenderer, ListrSimpleRenderer>,
				) => {
					const validators: ValidatorRecord = { non_empty: parsedValue.length > 0 };

					if (name === 'APP_KEY') {
						validators.regex = {
							id: 'base64_44char_v1',
							ok: /^base64:/.test(parsedValue) && parsedValue.length >= 44,
						};
						validators.length = parsedValue.length;
					}

					const payload = await buildSecretPayload({
						name,
                                                env: envName!,
                                                org: orgId ?? '',
                                                project: projectId,
						plaintext,
						masterSeed,
						edPriv,
						validators,
					});

					payloads.push(payload);
					task.title = `${name}  ${chalk.green('✓')}`;
				},
			})),
			{
				title: `Upload ${entries.length} variables`,
				task: async (
					_ctx: Ctx,
					task: ListrTaskWrapper<Ctx, ListrDefaultRenderer, ListrSimpleRenderer>,
				) => {
					await client.push(
						projectId,
						envName!,
						{ secrets: payloads },
						sync ? { sync: true } : undefined,
					);
					task.title = `Upload ${entries.length} variables  ${chalk.green('✓')}`;
				},
			},
		],
		{ concurrent: false, exitOnError: true },
	);

	try {
		await tasks.run();
		log.ok(
			`\n✅ Pushed ${entries.length} variables to ${projectId}:${envName} (encrypted locally).`,
		);
	} catch (error) {
		log.error(error);
		log.error(`\n❌ env:push failed: ${toErrorMessage(error)}`);
		process.exit(1);
	}
}
