import type { Settings } from "./settings";

export const SESSION_SETTINGS_QUIT_CHOICES = [
	"Keep in session directory",
	"Save to current project",
	"Discard session overrides",
	"Cancel quitting",
] as const;

/** A dismissed selector (Esc) retains session overrides and continues quitting. */
export async function settleSessionSettingsOnQuit(
	settings: Settings,
	select: (choices: readonly string[]) => Promise<string | undefined>,
	ensureSession: () => Promise<void>,
): Promise<boolean> {
	if (!settings.hasUnsavedSessionSettings) return true;
	const choice = await select(SESSION_SETTINGS_QUIT_CHOICES);
	if (choice === SESSION_SETTINGS_QUIT_CHOICES[3]) return false;
	const destination = choice === SESSION_SETTINGS_QUIT_CHOICES[1] ? "project"
		: choice === SESSION_SETTINGS_QUIT_CHOICES[2] ? "discard" : "session";
	if (destination === "session") await ensureSession();
	await settings.settleSessionSettings(destination);
	return true;
}
