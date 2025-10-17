import { Command } from 'commander';
import { config } from '../config/index.js';
import { SessionService } from '../services/SessionService.js';
import { GhostableClient } from '../services/GhostableClient.js';
import { log } from '../support/logger.js';
import type { Project } from '@/domain';

export function registerProjectListCommand(program: Command) {
	program
		.command('project:list')
		.alias('projects:list')
		.description('List the projects within the current organization context.')
		.action(async () => {
                        const sessionSvc = new SessionService();
			const sess = await sessionSvc.load();
			if (!sess?.accessToken) {
				log.error('❌ Not authenticated. Run `ghostable login`.');
				process.exit(1);
			}
			const orgId = sess.organizationId;
			if (!orgId) {
				log.error('❌ No organization selected. Run `ghostable org:switch`.');
				process.exit(1);
			}

                        const client = GhostableClient.unauthenticated(config.apiBase).withToken(
                                sess.accessToken,
                        );
			const projects: Project[] = (await client.projects(orgId)).sort((a, b) =>
				a.name.localeCompare(b.name),
			);

			if (!projects.length) {
				log.warn('No projects found in this organization.');
				return;
			}

                        const rows = projects.map((p: Project) => {
                                const envs = (p.environments ?? [])
                                        .map((env) => env.name as string)
                                        .filter((name): name is string => Boolean(name))
					.join(', ');

				return { ID: p.id, Name: p.name, Environments: envs };
			});

                        const keyed = Object.fromEntries(
                                rows.map((r) => [r.Name || r.ID, { ID: r.ID, Environments: r.Environments }]),
                        );
			console.table(keyed);
		});
}
