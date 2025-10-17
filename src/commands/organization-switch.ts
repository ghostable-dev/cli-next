import { Command } from 'commander';
import { select } from '@inquirer/prompts';
import { config } from '../config/index.js';
import { SessionService } from '../services/SessionService.js';
import { GhostableClient } from '../services/GhostableClient.js';
import { log } from '../support/logger.js';

export function registerOrganizationSwitchCommand(program: Command) {
	program
		.command('org:switch')
		.aliases(['orgs:switch', 'organizations:switch', 'organization:switch', 'switch'])
		.description(
			'Switch to a different organization context (used as default in subsequent commands)',
		)
		.option('--id <ORG_ID>', 'Organization ID to switch to (skip prompt)')
		.action(async (opts) => {
			const sessionSvc = new SessionService();
			const sess = await sessionSvc.load();
			if (!sess?.accessToken) {
				log.error('❌ Not authenticated. Run `ghostable login`.');
				process.exit(1);
			}

			const client = GhostableClient.unauthenticated(config.apiBase).withToken(
				sess.accessToken,
			);
			const orgs = await client.organizations();

			if (!orgs.length) {
				log.error('❌ No organizations available. Create one in the dashboard first.');
				process.exit(1);
			}

                        let targetId = opts.id as string | undefined;
			if (targetId) {
				const match = orgs.find((o) => o.id === targetId);
				if (!match) {
					log.error(`❌ Organization [${targetId}] not found.`);
					process.exit(1);
				}
			} else {
				targetId = await select({
					message: 'Which organization would you like to switch to?',
					choices: orgs
						.slice()
						.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
						.map((o) => ({ name: o.name ?? o.id, value: o.id })),
				});
			}

                        await sessionSvc.save({
                                accessToken: sess.accessToken,
                                organizationId: targetId,
				expiresAt: sess.expiresAt,
			});

			const name = orgs.find((o) => o.id === targetId)?.name ?? targetId;
			log.ok(`✅ Using organization: ${name}`);
		});
}
