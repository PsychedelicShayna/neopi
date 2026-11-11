import { Search } from "lucide-react";
import { useTranslation } from "../i18n";

export interface SearchInputProps {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	label?: string;
	width?: number;
}

/** Text filter with a leading search glyph. */
export function SearchInput({ value, onChange, placeholder, label, width }: SearchInputProps) {
	const tr = useTranslation();
	return (
		<label className="search">
			<Search size={14} />
			<input
				className="input"
				type="search"
				aria-label={label === undefined ? tr("common.filter", "Filter") : label}
				value={value}
				placeholder={placeholder === undefined ? tr("common.filter_placeholder", "Filter…") : placeholder}
				onChange={e => onChange(e.target.value)}
				style={width !== undefined ? { width } : undefined}
			/>
		</label>
	);
}
