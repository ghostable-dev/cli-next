import { Command } from 'commander';
import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import path from 'node:path';

import { Manifest } from '../support/Manifest.js';
import { config } from '../config/index.js';
import { SessionService } from '../services/SessionService.js';
import { GhostableClient } from '../services/GhostableClient.js';
import { log } from '../support/logger.js';
import { toErrorMessage } from '../support/errors.js';
import { resolveWorkDir } from '../support/workdir.js';
import { getIgnoredKeys, filterIgnoredKeys } from '../support/ignore.js';

import { initSodium } from '../crypto.js';
import { decryptBundle } from '../support/deploy-helpers.js';
import { readEnvFileSafe, resolveEnvFile } from '../support/env-files.js';

import type { EnvironmentSecretBundle } from '@/domain';

type DiffOptions = {
        token?: string;
        env?: string;
        file?: string;
        only?: string[];
        includeMeta?: boolean;
        showIgnored?: boolean;
};

export function registerEnvDiffCommand(program: Command) {
	program
		.command('env:diff')
		.description('Show differences between your local .env and Ghostable (zero-knowledge).')
		.option('--env <ENV>', 'Environment name (if omitted, select from manifest)')
		.option('--file <PATH>', 'Local .env path (default: .env.<env> or .env)')
		.option('--token <TOKEN>', 'API token (or stored session / GHOSTABLE_TOKEN)')
		.option('--only <KEY...>', 'Only diff these keys')
		.option('--include-meta', 'Include meta flags in bundle', false)
		.option('--show-ignored', 'Display ignored keys', false)
                .action(async (opts: DiffOptions) => {
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
					message: 'Which environment would you like to diff?',
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

                        await initSodium();
			const { secrets, warnings } = await decryptBundle(bundle);
			for (const w of warnings) log.warn(`⚠️ ${w}`);

                        const remoteMap: Record<string, { value: string; commented: boolean }> = {};
			for (const s of secrets) {
				remoteMap[s.entry.name] = {
					value: s.value,
					commented: Boolean(s.entry.meta?.is_commented),
				};
			}

                        const workDir = resolveWorkDir();
                        const envPath = resolveEnvFile(envName!, opts.file, false);
			const localVars = readEnvFileSafe(envPath);
                        const localMap: Record<string, { value: string; commented: boolean }> = {};
			for (const [k, v] of Object.entries(localVars)) {
				localMap[k] = { value: v, commented: false };
			}

                        const ignored = getIgnoredKeys(envName);
			const localFiltered = filterIgnoredKeys(localMap, ignored, opts.only);
			const remoteFiltered = filterIgnoredKeys(remoteMap, ignored, opts.only);
			const ignoredKeysUsed =
				opts.only && opts.only.length
					? []
					: ignored.filter((key) => key in localMap || key in remoteMap);

			if (opts.showIgnored) {
				const message = ignoredKeysUsed.length
					? `Ignored keys (${ignoredKeysUsed.length}): ${ignoredKeysUsed.join(', ')}`
					: 'Ignored keys (0): none';
				log.info(message);
			}

                        const restrict = (keys: string[]) =>
                                opts.only && opts.only.length ? keys.filter((k) => opts.only!.includes(k)) : keys;

                        const added: string[] = [];
                        const updated: string[] = [];
                        const removed: string[] = [];

                        for (const key of restrict(Object.keys(localFiltered))) {
				if (!(key in remoteFiltered)) {
					added.push(key);
				} else {
					const lv = localFiltered[key].value;
					const rv = remoteFiltered[key].value;
					const localCommented = localFiltered[key].commented;
					const remoteCommented = remoteFiltered[key].commented;
					if (lv !== rv || localCommented !== remoteCommented) {
						updated.push(key);
					}
				}
			}

                        for (const key of restrict(Object.keys(remoteFiltered))) {
                                if (!(key in localFiltered)) {
                                        removed.push(key);
                                }
                        }

                        if (!added.length && !updated.length && !removed.length) {
                                log.info('No differences detected.');
                                return;
			}

			log.info(chalk.bold(`Diff for ${projectName}:${envName}`));
			if (added.length) {
				console.log(chalk.green('\nAdded variables:'));
				for (const k of added) {
					const v = localFiltered[k]?.value ?? '';
					console.log(`  ${chalk.green('+')} ${k}=${v}`);
				}
			}
			if (updated.length) {
				console.log(chalk.yellow('\nUpdated variables:'));
				for (const k of updated) {
					const cur = remoteFiltered[k]?.value ?? '';
					const inc = localFiltered[k]?.value ?? '';
					const commentChanged =
						(remoteFiltered[k]?.commented ?? false) !==
						(localFiltered[k]?.commented ?? false);
					const note = commentChanged ? ' (commented state changed)' : '';
					console.log(`  ${chalk.yellow('~')} ${k}: ${cur} -> ${inc}${note}`);
				}
			}
			if (removed.length) {
				console.log(chalk.red('\nRemoved variables:'));
				for (const k of removed) {
					const v = remoteFiltered[k]?.value ?? '';
					const comment = (remoteFiltered[k]?.commented ?? false) ? ' (commented)' : '';
					console.log(`  ${chalk.red('-')} ${k}=${v}${comment}`);
				}
			}

                        console.log('');
			log.ok(`Done. Compared local ${path.relative(workDir, envPath)} against Ghostable.`);
		});
}
