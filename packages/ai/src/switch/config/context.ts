import * as path from "node:path";
import type { Issue } from "../wire";
import type { ConfigFields } from "./fields";
import type { SecretRef } from "./types";

export interface SecretRequest { reference: SecretRef; location: string }
export interface DecodeContext {
	fields: ConfigFields;
	warnings: Issue[];
	configDir: string;
	source: string;
	secrets: SecretRequest[];
}

export function warning(context: DecodeContext, code: string, location: string, message: string): void {
	context.warnings.push({ code, path: location, message });
}

export function secretReference(context: DecodeContext, value: unknown, location: string, sealed = false): SecretRef {
	const { fields } = context;
	const text = fields.text(value, location);
	let reference: SecretRef;
	if (text.startsWith("file:")) {
		if (!text.slice(5) || text.includes("\0")) fields.issue(location, "Secret file path is missing or invalid", "E-SECRET-MISSING");
		reference = { kind: "file", path: path.resolve(context.configDir, text.slice(5)) };
	} else if (text.startsWith("env:")) {
		const name = text.slice(4);
		if (!name || /[=\0]/.test(name)) fields.issue(location, "Secret environment name is missing or invalid", "E-SECRET-MISSING");
		reference = { kind: "env", name };
	} else if (text.startsWith("sha256:")) {
		const digest = text.slice(7);
		if (!sealed || !/^[a-f0-9]{64}$/i.test(digest)) fields.issue(location, "Only admin tokens accept a sealed SHA-256 digest", "E-SECRET-MISSING");
		reference = { kind: "sealed", sha256: digest.toLowerCase() };
	} else {
		reference = { kind: "inline", value: text };
		if (!context.warnings.some(issue => issue.code === "W-INLINE-SECRET" && issue.path === context.source)) warning(context, "W-INLINE-SECRET", context.source, "This file contains an inline secret");
	}
	context.secrets.push({ reference, location });
	return reference;
}
