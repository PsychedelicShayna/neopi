import type { Database } from "bun:sqlite";
import { isDeepStrictEqual } from "node:util";
import { parseSettingsToml as parse, stringifySettingsToml as stringify } from "@oh-my-pi/pi-utils/settings-toml";
import { preserveLegacyYamlComments } from "@oh-my-pi/pi-utils/legacy-yaml-import";
import { parseDocument } from "yaml";
import { validateRoutineSpec } from "@npi-deck/protocol";
import { logger } from "../log.ts";

const log = logger("routine-toml-import");

/** Read-only import boundary. Refuse values TOML cannot represent without loss. */
export function importLegacyRoutineYaml(source: string): string {
	try {
		const document = parseDocument(source, { uniqueKeys: true });
		if (document.errors.length) throw new Error();
		const spec: unknown = document.toJS({ maxAliasCount: 100 });
		if (!validateRoutineSpec(spec).valid) throw new Error();
		const toml = stringify(spec as Record<string, unknown>);
		if (!isDeepStrictEqual(parse(toml), spec)) throw new Error();
		return preserveLegacyYamlComments(source, toml);
	} catch {
		throw new Error("Legacy routine cannot be imported losslessly; original spec_yaml is unchanged");
	}
}

export function migrateLegacyRoutineSpecs(db: Database): void {
	const rows = db
		.query<{ id: string; spec_yaml: string }, []>(
			"SELECT id, spec_yaml FROM routines WHERE spec_version = 1 AND spec_toml IS NULL AND spec_yaml IS NOT NULL",
		)
		.all();
	for (const row of rows) {
		try {
			const toml = importLegacyRoutineYaml(row.spec_yaml);
			db.query("UPDATE routines SET spec_toml = ? WHERE id = ? AND spec_toml IS NULL").run(toml, row.id);
			log.info(`Imported legacy routine ${row.id} to spec_toml; spec_yaml preserved`);
		} catch {
			log.warn(`Legacy routine ${row.id} requires manual conversion; spec_yaml preserved`);
		}
	}
}
