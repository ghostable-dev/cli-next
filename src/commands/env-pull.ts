import { Command } from 'commander';
import { select } from '@inquirer/prompts';
import fs from 'node:fs';
import path from 'node:path';

import { Manifest } from '../support/Manifest.js';
import { config } from '../config/index.js';
import { SessionService } from '../services/SessionService.js';
import { GhostableClient } from '../services/GhostableClient.js';
import { initSodium, deriveKeys, aeadDecrypt, scopeFromAAD } from '../crypto.js';
import { loadOrCreateKeys } from '../keys.js';
import { log } from '../support/logger.js';
import { toErrorMessage } from '../support/errors.js';
import { resolveWorkDir } from '../support/workdir.js';
import { getIgnoredKeys, filterIgnoredKeys } from '../support/ignore.js';
import { readEnvFileSafeWithMetadata } from '../support/env-files.js';

import type { EnvironmentSecret, EnvironmentSecretBundle } from '@/domain';

type PullOptions = {
        token?: string;
        env?: string;
        file?: string;
        only?: string[];
        includeMeta?: boolean;
        dryRun?: boolean;
        showIgnored?: boolean;
        replace?: boolean;
        pruneLocal?: boolean;
	noBackup?: boolean;
	backup?: boolean;
};

function resolveOutputPath(envName: string | undefined, explicit?: string): string {
	const workDir = resolveWorkDir();
	if (explicit) return path.resolve(workDir, explicit);
	if (envName) return path.resolve(workDir, `.env.${envName}`);
	return path.resolve(workDir, '.env');
}

function lineForDotenv(name: string, value: string, commented = false): string {
	const safe = value.includes('\n') ? JSON.stringify(value) : value;
	return commented ? `# ${name}=${safe}` : `${name}=${safe}`;
}

export function registerEnvPullCommand(program: Command) {
	program
		.command('env:pull')
		.description('Pull and decrypt environment variables into a local .env file.')
		.option('--env <ENV>', 'Environment name (if omitted, select from manifest)')
		.option('--file <PATH>', 'Output file (default: .env.<env> or .env)')
		.option('--token <TOKEN>', 'API token (or stored session / GHOSTABLE_TOKEN)')
		.option('--only <KEY...>', 'Only include these keys')
		.option('--include-meta', 'Include meta flags in bundle', false)
		.option('--dry-run', 'Do not write file; just report', false)
		.option('--show-ignored', 'Display ignored keys', false)
		.option('--replace', 'Replace local file instead of merging', false)
		.option('--prune-local', 'Alias for --replace', false)
		.option('--no-backup', 'Do not create a backup before writing')
                .action(async (opts: PullOptions) => {
                        let projectId: string, projectName: string, envNames: string[];
			try {
				projectId = Manifest.id();
				projectName = Manifest.name();
				envNames = Manifest.environmentNames();
			} catch (error) {
				log.error(toErrorMessage(error));
				process.exit(1);
				return;
			}
			if (!envNames.length) {
				log.error('❌ No environments defined in ghostable.yml.');
				process.exit(1);
			}

                        let envName = opts.env?.trim();
			if (!envName) {
				envName = await select<string>({
					message: 'Which environment would you like to pull?',
					choices: envNames.sort().map((n) => ({ name: n, value: n })),
				});
			}

                        let token = opts.token || process.env.GHOSTABLE_TOKEN || '';
			if (!token) {
				const sessionSvc = new SessionService();
				const sess = await sessionSvc.load();
				if (!sess?.accessToken) {
					log.error(
						'❌ No API token. Run `ghostable login` or pass --token / set GHOSTABLE_TOKEN.',
					);
					process.exit(1);
				}
				token = sess.accessToken;
			}

                        const client = GhostableClient.unauthenticated(config.apiBase).withToken(token);
			let bundle: EnvironmentSecretBundle;
			try {
				bundle = await client.pull(projectId, envName!, {
					includeMeta: !!opts.includeMeta,
					includeVersions: true,
					only: opts.only,
				});
			} catch (error) {
				log.error(`❌ Failed to pull environment bundle: ${toErrorMessage(error)}`);
				process.exit(1);
				return;
			}

			if (!bundle.secrets.length) {
				log.warn('No secrets returned; nothing to write.');
				return;
			}

                        await initSodium();
			const keyBundle = await loadOrCreateKeys();
			const masterSeed = Buffer.from(keyBundle.masterSeedB64.replace(/^b64:/, ''), 'base64');

                        const chainOrder: readonly string[] = bundle.chain;
			const byEnv = new Map<string, EnvironmentSecret[]>();
			for (const entry of bundle.secrets) {
				if (!byEnv.has(entry.env)) byEnv.set(entry.env, []);
				byEnv.get(entry.env)!.push(entry);
			}

			const merged: Record<string, string> = {};
			const commentFlags: Record<string, boolean> = {};

			for (const layer of chainOrder) {
				const entries: EnvironmentSecret[] = byEnv.get(layer) || [];
				for (const entry of entries) {
                                        const scope = scopeFromAAD(entry.aad);
                                        const { encKey } = deriveKeys(masterSeed, scope);

					try {
						const plaintext = aeadDecrypt(encKey, {
							alg: entry.alg,
							nonce: entry.nonce,
							ciphertext: entry.ciphertext,
							aad: entry.aad,
						});
						const value = new TextDecoder().decode(plaintext);

                                                merged[entry.name] = value;

                                                commentFlags[entry.name] = Boolean(entry.meta?.is_commented);
					} catch {
						log.warn(`⚠️ Could not decrypt ${entry.name}; skipping`);
					}
				}
			}

			const ignored = getIgnoredKeys(envName);
			const filteredMerged = filterIgnoredKeys(merged, ignored, opts.only);
			const filteredComments = filterIgnoredKeys(commentFlags, ignored, opts.only);
			const ignoredKeysUsed =
				opts.only && opts.only.length ? [] : ignored.filter((key) => key in merged);

			if (opts.showIgnored) {
				const message = ignoredKeysUsed.length
					? `Ignored keys (${ignoredKeysUsed.length}): ${ignoredKeysUsed.join(', ')}`
					: 'Ignored keys (0): none';
				log.info(message);
			}

                        const outputPath = resolveOutputPath(envName!, opts.file);
			const { vars: existingVars, snapshots } = readEnvFileSafeWithMetadata(outputPath);

			const replace = Boolean(opts.replace || opts.pruneLocal);
			const noBackup = opts.backup === false || opts.noBackup === true;
			console.log(noBackup);
			const serverKeys = Object.keys(filteredMerged);

			let createCount = 0;
			let updateCount = 0;
			for (const key of serverKeys) {
				const current = existingVars[key];
				if (current === undefined) {
					createCount += 1;
					continue;
				}
				if (current !== filteredMerged[key]) {
					updateCount += 1;
				}
			}

			let deleteCount = 0;
			if (replace) {
				for (const key of Object.keys(existingVars)) {
					if (!(key in filteredMerged)) {
						deleteCount += 1;
					}
				}
			}

			const hasChanges = createCount > 0 || updateCount > 0 || (replace && deleteCount > 0);

			const summaryParts = [`CREATE ${createCount}`, `UPDATE ${updateCount}`];
			if (replace) summaryParts.push(`DELETE ${deleteCount}`);
			const summary = summaryParts.join(' | ');
			log.info(summary);

			if (opts.dryRun) {
				const dryRunMsg = hasChanges
					? `Dry run: would update ${outputPath}`
					: `Dry run: no changes for ${outputPath}`;
				log.info(dryRunMsg);
				process.exit(0);
			}

			if (!hasChanges) {
				log.ok(`✅ ${outputPath} is already up to date for ${projectName}:${envName}.`);
				return;
			}

			const finalEntries = new Map<string, { value: string; comment?: boolean }>();

			if (!replace) {
				for (const [key, value] of Object.entries(existingVars)) {
					finalEntries.set(key, { value });
				}
			}

			for (const key of serverKeys) {
				finalEntries.set(key, {
					value: filteredMerged[key],
					comment: Boolean(filteredComments[key]),
				});
			}

			const lines = Array.from(finalEntries.keys())
				.sort((a, b) => a.localeCompare(b))
				.map((key) => {
					const entry = finalEntries.get(key)!;
					if (entry.comment) {
						return lineForDotenv(key, entry.value, true);
					}

					const snapshot = snapshots[key];
					if (snapshot && snapshot.value === entry.value) {
						return `${key}=${snapshot.rawValue}`;
					}

					return lineForDotenv(key, entry.value);
				});

			const content = lines.join('\n') + '\n';

			if (!noBackup && fs.existsSync(outputPath)) {
				const timestamp = new Date().toISOString().replace(/:/g, '-');
				const { dir, base } = path.parse(outputPath);
				const backupPath = path.join(dir, `${base}.bak-${timestamp}`);
				fs.copyFileSync(outputPath, backupPath);
				log.info(`Backup created at ${backupPath}`);
			}

			fs.writeFileSync(outputPath, content, 'utf8');

			log.ok(`✅ Updated ${outputPath} for ${projectName}:${envName}.`);
		});
}
