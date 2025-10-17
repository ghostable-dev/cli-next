import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { Command } from 'commander';

export async function registerAllCommands(program: Command) {
        const here = fileURLToPath(new URL('.', import.meta.url));
        const files = fs
                .readdirSync(here)
                .filter(
                        (f) =>
                                f.endsWith('.js') &&
                                !f.startsWith('_') &&
                                !f.endsWith('.d.ts') &&
                                !f.endsWith('.map'),
                )
                .sort();

        for (const file of files) {
                const full = path.join(here, file);
                const mod = await import(pathToFileURL(full).href);

                if (typeof mod.default === 'function') {
                        mod.default(program);
                        continue;
                }

                for (const [name, value] of Object.entries(mod)) {
                        if (typeof value === 'function' && /^register[A-Z]/.test(name)) {
                                value(program);
			}
		}
	}
}
