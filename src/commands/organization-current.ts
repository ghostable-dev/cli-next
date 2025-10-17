import { Command } from 'commander';
import { config } from '../config/index.js';
import { SessionService } from '../services/SessionService.js';
import { GhostableClient } from '../services/GhostableClient.js';
import { log } from '../support/logger.js';

export function registerOrganizationCurrentCommand(program: Command) {
	program
		.command('org:current')
		.aliases(['orgs:current', 'organizations:current', 'organization:current', 'current'])
		.description('Show your current organization context.')
		.action(async () => {
                        const sessionSvc = new SessionService();
			const sess = await sessionSvc.load();
			if (!sess?.accessToken) {
				log.error('❌ Not authenticated. Run `ghostable login`.');
				process.exit(1);
			}

			const currentOrgId = sess.organizationId;
			if (!currentOrgId) {
				log.error('❌ No organization selected. Run `ghostable org:switch` to select one.');
				process.exit(1);
			}

                        const client = GhostableClient.unauthenticated(config.apiBase).withToken(
                                sess.accessToken,
                        );
			const orgs = await client.organizations();
			const org = orgs.find((o) => o.id === currentOrgId);

                        if (!org) {
                                log.error('❌ Unable to determine current organization (not found in API list).');
				process.exit(1);
			}

			log.ok(`✅ Current organization: ${org.name ?? currentOrgId}`);
		});
}
