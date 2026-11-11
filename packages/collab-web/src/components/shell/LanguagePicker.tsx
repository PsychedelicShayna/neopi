import { setLanguage, useLanguage, useTranslation } from "../../lib/i18n";

/** Guests choose their own language; it is never sent to the collaboration host. */
export function LanguagePicker() {
	const language = useLanguage();
	const tr = useTranslation();
	return (
		<select
			className="sh-language"
			aria-label={tr("language.label", "Language")}
			value={language}
			onChange={event => setLanguage(event.target.value === "es" ? "es" : "en")}
		>
			<option value="en">English</option>
			<option value="es">Español</option>
		</select>
	);
}
