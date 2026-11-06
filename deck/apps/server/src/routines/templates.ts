/**
 * Routine templates. Each `.toml` file under `apps/server/src/templates/` is a
 * pre-authored V1 routine spec the user can install via:
 *
 *   GET  /api/routines/templates           — list available templates
 *   POST /api/routines/templates/:slug      — install + return the routine row
 *
 * Installation is plain `createV1Routine` with the parsed spec. Templates ship
 * with `enabled: false` by default so a fresh install doesn't fire unscheduled
 * agent runs against the user's BYOK keys.
 *
 * V1 ships `daily-briefing` and `kb-orphan-census`; the visual builder's marketplace
 * (Phase 3 / V2) surfaces them in a curated catalog with screenshots + tags.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { parseSettingsToml, readTomlConfigSync } from "@oh-my-pi/pi-utils/settings-toml";

import type { RoutineSpec } from "@npi-deck/protocol";

import { routineTemplatesDir } from "../assets.ts";
import { logger } from "../log.ts";
import { importLegacyRoutineYaml } from "./legacy-yaml.ts";

const TEMPLATES_DIR = routineTemplatesDir();
const log = logger("routine-templates");

export interface TemplateSummary {
	slug: string;
	name: string;
	description?: string;
	tags?: string[];
	steps: number;
	triggers: number;
}

/**
 * List native templates, importing YAML-only user templates on first access.
 * Legacy files remain untouched; an existing TOML sibling always wins.
 */
export function listTemplates(directory = TEMPLATES_DIR): TemplateSummary[] {
	if (!fs.existsSync(directory)) return [];
	const slugs = new Set(
		fs
			.readdirSync(directory)
			.filter(file => /\.(?:toml|ya?ml)$/.test(file))
			.map(file => file.replace(/\.(?:toml|ya?ml)$/, "")),
	);
	const out: TemplateSummary[] = [];
	for (const slug of slugs) {
		const loaded = loadTemplate(slug, directory);
		if (!loaded) continue;
		const { spec } = loaded;
		const summary: TemplateSummary = {
			slug,
			name: spec.name ?? slug,
			steps: spec.steps?.length ?? 0,
			triggers: spec.trigger?.length ?? 0,
		};
		if (spec.description) summary.description = spec.description;
		if (spec.tags) summary.tags = spec.tags;
		out.push(summary);
	}
	return out;
}

/** Read + parse a template by slug. Returns the spec + raw TOML. */
export function loadTemplate(slug: string, directory = TEMPLATES_DIR): { spec: RoutineSpec; specToml: string } | null {
	if (!/^[a-z][a-z0-9-]*$/.test(slug)) return null;
	const target = path.join(directory, `${slug}.toml`);
	try {
		const source = readTomlConfigSync(target, {
			legacyPaths: [path.join(directory, `${slug}.yaml`), path.join(directory, `${slug}.yml`)],
			parseLegacy: content => parseSettingsToml(importLegacyRoutineYaml(content)),
		});
		if (!source) return null;
		return { spec: source.data as unknown as RoutineSpec, specToml: source.content };
	} catch {
		// Diagnostics identify the template, never user-authored values or secrets.
		log.warn(`Cannot load routine template ${slug}; original source preserved`);
		return null;
	}
}
