import { Command } from 'commander';
import { config } from '../config/index.js';
import { SessionService } from '../services/SessionService.js';
import { GhostableClient } from '../services/GhostableClient.js';
import { log } from '../support/logger.js';

export function registerOrganizationListCommand(program: Command) {
	program
		.command('org:list')
		.aliases(['orgs:list', 'organizations:list', 'organization:list'])
		.description('List the organizations that you belong to.')
		.action(async () => {
                        const sessionSvc = new SessionService();
			const sess = await sessionSvc.load();
			if (!sess?.accessToken) {
				log.error('❌ Not authenticated. Run `ghostable login`.');
				process.exit(1);
			}
			const currentOrgId = sess.organizationId;

                        const client = GhostableClient.unauthenticated(config.apiBase).withToken(
                                sess.accessToken,
                        );
			const orgs = (await client.organizations()).sort((a, b) =>
				(a.name ?? '').localeCompare(b.name ?? ''),
			);

			if (orgs.length === 0) {
				log.warn('No organizations found for this account.');
				return;
			}

                        const rows = orgs.map((o) => ({
				ID: o.id,
				Name: o.name ?? '',
				Current: o.id === currentOrgId ? '✅' : '',
			}));

                        console.table(rows);
		});
}
