import { Command } from 'commander';
import { select, input } from '@inquirer/prompts';
import ora from 'ora';

import { Manifest } from '../support/Manifest.js';
import { SessionService } from '../services/SessionService.js';
import { GhostableClient } from '../services/GhostableClient.js';
import { config } from '../config/index.js';
import { log } from '../support/logger.js';
import { toErrorMessage } from '../support/errors.js';

import type { Project } from '@/domain';

export function registerOrganizationListCommand(program: Command) {
	program
		.command('init')
		.description(
			'Initialize a new project in the current directory within the current organization context.',
		)
		.action(async () => {
			const apiBase = config.apiBase;

                        const sessions = new SessionService();
			const sess = await sessions.load();
			if (!sess?.accessToken) {
				log.error('❌ Not authenticated. Run `ghostable login` first.');
				process.exit(1);
			}
			if (!sess.organizationId) {
				log.error(
					'❌ No organization selected. Run `ghostable login` and pick an organization (or add an org switch command).',
				);
				process.exit(1);
			}

			const client = GhostableClient.unauthenticated(apiBase).withToken(sess.accessToken);

                        const spinner = ora('Loading projects…').start();
			let projects: Project[] = [];
			try {
				projects = await client.projects(sess.organizationId);
				spinner.succeed(
					`Loaded ${projects.length} project${projects.length === 1 ? '' : 's'}.`,
				);
			} catch (error) {
				spinner.fail('Failed loading projects.');
				log.error(toErrorMessage(error));
				process.exit(1);
			}

                        const choices = [
				{ name: '[Create a new project]', value: '__new__' },
				...projects.map((p) => ({ name: p.name || p.id, value: p.id })),
			];

			const selection = await select<string>({
				message: 'Which project should this directory be linked to?',
				choices,
				pageSize: Math.min(10, choices.length || 1),
				default: '__new__',
			});

			let project: Project;

			if (selection !== '__new__') {
				const found = projects.find((p) => p.id === selection);
				if (!found) {
					log.error('❌ Selected project not found.');
					process.exit(1);
				}
				project = found;
			} else {
				const name = await input({
					message: 'What is the name of this project?',
					validate: (v) => (v && v.trim().length > 0) || 'Project name is required',
				});

				const createSpin = ora('Creating project…').start();
				try {
					project = await client.createProject({
						organizationId: sess.organizationId,
						name: name.trim(),
					});
					createSpin.succeed(`Project created: ${project.name}`);
				} catch (error) {
					createSpin.fail('Failed creating project.');
					log.error(toErrorMessage(error));
					process.exit(1);
				}
			}

                        try {
				const manifestEnvs =
					project.environments?.map((env: { name: string; type: string }) => ({
						name: env.name,
						type: env.type ?? undefined,
					})) ?? [];

				Manifest.fresh({
					id: project.id,
					name: project.name,
					environments: manifestEnvs,
				});

				log.ok(`✅ ${project.name} initialized. ${Manifest.resolve()} created.`);
			} catch (error) {
				log.error(`❌ Failed writing manifest: ${toErrorMessage(error)}`);
				process.exit(1);
			}
		});
}
