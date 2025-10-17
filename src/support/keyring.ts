export type Keytar = {
	getPassword(service: string, account: string): Promise<string | null>;
	setPassword(service: string, account: string, password: string): Promise<void>;
	deletePassword(service: string, account: string): Promise<boolean>;
};

const DEPLOY_COMMANDS = new Set(['deploy:forge', 'deploy:cloud', 'deploy:vapor', 'env:deploy']);

function argvHasToken(argv: string[]): boolean {
	return argv.includes('--token') || argv.some((a) => a.startsWith('--token='));
}

function isDeployCommand(argv: string[]): boolean {
        return argv.some((a) => DEPLOY_COMMANDS.has(a));
}

/**
 * Only allow OS keychain when we're *not* deploying and no token was provided.
 * If a deploy command is detected OR a token is passed via flag/env, we disable keychain.
 */
export function allowKeyring(argv: string[] = process.argv.slice(2)): boolean {
	if (isDeployCommand(argv)) return false;
	if (argvHasToken(argv)) return false;
	if (process.env.GHOSTABLE_CI_TOKEN?.trim()) return false;
	return true;
}

export async function loadKeytar(argv: string[] = process.argv.slice(2)): Promise<Keytar | null> {
	if (!allowKeyring(argv)) return null;
	try {
		const mod = await import('keytar');
		return (mod.default ?? mod) as Keytar;
        } catch {
                return null;
        }
}
