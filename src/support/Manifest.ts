import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

import { resolveWorkDir } from './workdir.js';

export interface EnvConfig {
	type?: string;
	ignore?: string[];
	[key: string]: unknown;
}

export type EnvEntry = EnvConfig | undefined;
export type ManifestEnvsLegacy =
	| string[]
	| Array<string | { name: string; type?: string; ignore?: string[] }>;
export type ManifestEnvs = Record<string, EnvEntry> | ManifestEnvsLegacy;

export interface ManifestShape {
	id?: string;
	name?: string;
	environments?: ManifestEnvs;
	[key: string]: unknown;
}

function defaultPath(): string {
	return path.resolve(resolveWorkDir(), 'ghostable.yml');
}

/** Resolve manifest path: env var wins, else cwd/ghostable.yml */
export function resolveManifestPath(): string {
	return process.env.GHOSTABLE_MANIFEST?.trim() || defaultPath();
}

/** Throw with a helpful message (keeps commands clean) */
function fail(msg: string): never {
	throw new Error(msg);
}

function readYaml(file: string): ManifestShape {
	const raw = fs.readFileSync(file, 'utf8');
	const data = yaml.load(raw);

	if (!data || typeof data !== 'object') {
		return {};
	}

	return data as ManifestShape;
}

function writeYaml(file: string, manifest: ManifestShape) {
	const doc = yaml.dump(manifest, {
		indent: 2,
		lineWidth: 120,
		noRefs: true,
		sortKeys: false,
	});
	fs.writeFileSync(file, doc, 'utf8');
}

/** Convert legacy list formats to the normalized map format */
function normalizeEnvs(envs: ManifestEnvs | undefined): Record<string, EnvEntry> {
	if (!envs) return {};

	if (!Array.isArray(envs)) {
		return { ...envs };
	}

	const out: Record<string, EnvEntry> = {};
	for (const item of envs) {
		if (typeof item === 'string') {
			out[item] = {};
		} else if (item && typeof item === 'object') {
			const name = 'name' in item && typeof item.name === 'string' ? item.name : undefined;
			if (!name) continue;

			const type = 'type' in item && typeof item.type === 'string' ? item.type : undefined;
			const ignore =
				'ignore' in item && Array.isArray(item.ignore)
					? (item.ignore as string[]).filter(
							(value): value is string => typeof value === 'string',
						)
					: undefined;

			const entry: EnvConfig = {};
			if (type) entry.type = type;
			if (ignore) entry.ignore = [...ignore];

			out[name] = entry;
		}
	}
	return out;
}

export class Manifest {
	/** Load and return the current manifest (normalized) or throw if missing/invalid. */
	static current(file = resolveManifestPath()): ManifestShape {
		if (!fs.existsSync(file)) {
			fail(
				`Unable to find a Ghostable manifest at [${file}].\n→ Run 'ghostable init' to generate a new manifest file.`,
			);
		}
                const m = readYaml(file);
                const envs = normalizeEnvs(m.environments);
		return { ...m, environments: envs };
	}

	/** Project id (required) */
	static id(file = resolveManifestPath()): string {
		const m = this.current(file);
		if (!m.id) {
			fail(`Invalid project ID. Please verify your Ghostable manifest at [${file}].`);
		}
		return m.id!;
	}

	/** Project name (required) */
	static name(file = resolveManifestPath()): string {
		const m = this.current(file);
		if (!m.name) {
			fail(`Invalid project name. Please verify your Ghostable manifest at [${file}].`);
		}
		return m.name!;
	}

	/** Return manifest data if available, or undefined when missing */
	static data(file = resolveManifestPath()): ManifestShape | undefined {
		try {
			return this.current(file);
		} catch {
			return undefined;
		}
	}

	/** Write a fresh manifest from an API project payload */
	static fresh(
		project: {
			id: string;
			name?: string;
			environments?: ManifestEnvs;
		},
		file = resolveManifestPath(),
	): void {
		const envs = normalizeEnvs(project.environments);
		const manifest: ManifestShape = {
			id: project.id,
			name: project.name,
			environments: Object.fromEntries(
				Object.entries(envs).sort(([a], [b]) => a.localeCompare(b)),
			),
		};
		writeYaml(file, manifest);
	}

	/** Add or update a single environment */
	static addEnvironment(
		environment: { name: string; type?: string },
		file = resolveManifestPath(),
	): void {
		const m = this.current(file);
		const envs = normalizeEnvs(m.environments);
                envs[environment.name] = environment.type ? { type: environment.type } : {};
                const sorted = Object.fromEntries(
                        Object.entries(envs).sort(([a], [b]) => a.localeCompare(b)),
                );
		writeYaml(file, { ...m, environments: sorted });
	}

	/** Return just the environment names (handles legacy formats) */
	static environmentNames(file = resolveManifestPath()): string[] {
		const m = this.current(file);
		return Object.keys(normalizeEnvs(m.environments));
	}

	/** Get the 'type' for an environment (if any) */
	static environmentType(name: string, file = resolveManifestPath()): string | null {
		const m = this.current(file);
		const envs = normalizeEnvs(m.environments);
		const entry = envs[name];
		return entry?.type ?? null;
	}

	/** Overwrite manifest (advanced use) */
	static write(manifest: ManifestShape, file = resolveManifestPath()): void {
                const envs = normalizeEnvs(manifest.environments);
		const sorted = Object.fromEntries(
			Object.entries(envs).sort(([a], [b]) => a.localeCompare(b)),
		);
		writeYaml(file, { ...manifest, environments: sorted });
	}

	/** Default on-disk location */
	static defaultPath(): string {
		return defaultPath();
	}

	/** Path resolver (env var aware) */
	static resolve(): string {
		return resolveManifestPath();
	}
}
