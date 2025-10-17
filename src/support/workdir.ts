import fs from 'node:fs';
import path from 'node:path';

/**
 * Determine the on-disk directory the CLI should treat as the current project.
 *
 * In many execution environments (npm exec, pnpm dlx, etc.) the Node process
 * can start with a working directory that differs from the folder where the
 * user invoked the command. We look at a handful of well-known environment
 * variables exposed by the package managers and fall back to process.cwd().
 */
export function resolveWorkDir(): string {
	const fallback = process.cwd();
	const candidates = [
		process.env.GHOSTABLE_WORKDIR,
		process.env.INIT_CWD,
		process.env.PWD,
		fallback,
	];

	const seen = new Set<string>();

	for (const candidate of candidates) {
		if (!candidate) continue;

		const resolved = path.isAbsolute(candidate)
			? path.normalize(candidate)
			: path.resolve(fallback, candidate);

		if (seen.has(resolved)) continue;
		seen.add(resolved);

		try {
			const stat = fs.statSync(resolved);
			if (stat.isDirectory()) {
				return resolved;
			}
                } catch {
                }
        }

	return fallback;
}
