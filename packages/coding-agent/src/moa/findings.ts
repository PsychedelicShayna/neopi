import { getLocale, type Locale, t, type TranslationValues } from "@oh-my-pi/pi-utils/i18n";
import { type MixtureIssue, mixtureIssueValues } from "./types";

const PREFIX = "overlaysModel.moaWeb.editor.finding.";

/** Retain canonical English for logs and machine consumers. */
export function codedMixtureIssue(code: string, path: string, values?: TranslationValues): MixtureIssue {
	return { code, path, message: t("en", `${PREFIX}${code}`, values), [mixtureIssueValues]: values ?? {} };
}

/** Render a finding from its validator inputs, never from its English prose or location. */
export function formatMixtureIssue(issue: MixtureIssue, locale: Locale = getLocale()): string {
	const values = issue[mixtureIssueValues];
	return values ? t(locale, `${PREFIX}${issue.code}`, values) : issue.message;
}
