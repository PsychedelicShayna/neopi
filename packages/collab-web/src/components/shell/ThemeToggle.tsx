import { type LucideIcon, Monitor, Moon, Sun } from "lucide-react";
import { type ThemePreference, useThemePreference } from "../../lib/theme";
import { useTranslation } from "../../lib/i18n";

const NEXT_PREFERENCE: Record<ThemePreference, ThemePreference> = {
	system: "light",
	light: "dark",
	dark: "system",
};

const PREFERENCE_ICON: Record<ThemePreference, LucideIcon> = {
	system: Monitor,
	light: Sun,
	dark: Moon,
};

const PREFERENCE_LABEL: Record<ThemePreference, string> = {
	system: "System theme",
	light: "Light theme",
	dark: "Dark theme",
};

export function ThemeToggle() {
	const tr = useTranslation();
	const { preference, setPreference } = useThemePreference();
	const Icon = PREFERENCE_ICON[preference];

	return (
		<button
			type="button"
			className="sh-theme-toggle"
			onClick={() => setPreference(NEXT_PREFERENCE[preference])}
			aria-label={`${tr(`theme.${preference}`, PREFERENCE_LABEL[preference])} (${tr("theme.switch", "click to switch")})`}
			title={`${tr(`theme.${preference}`, PREFERENCE_LABEL[preference])} — ${tr("theme.switch", "click to switch")}`}
		>
			<Icon size={16} />
		</button>
	);
}
