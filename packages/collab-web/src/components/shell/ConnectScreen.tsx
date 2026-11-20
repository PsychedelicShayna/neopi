import { ArrowRight, Lock } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import { useTranslation } from "../../lib/i18n";
import { LanguagePicker } from "./LanguagePicker";
import { OmpMark } from "./OmpMark";
import { ThemeToggle } from "./ThemeToggle";

export interface ConnectScreenProps {
	defaultName: string;
	error: string | null;
	onConnect(link: string, name: string): void;
}

export function ConnectScreen({ defaultName, error, onConnect }: ConnectScreenProps): ReactNode {
	const tr = useTranslation();
	const [link, setLink] = useState("");
	const [name, setName] = useState(defaultName);
	const [missingLink, setMissingLink] = useState(false);

	const submit = (e: FormEvent<HTMLFormElement>): void => {
		e.preventDefault();
		const trimmed = link.trim();
		if (!trimmed) {
			setMissingLink(true);
			return;
		}
		setMissingLink(false);
		onConnect(trimmed, name.trim() || "guest");
	};

	const shown = missingLink ? tr("connect.missing_link", "Paste a join link first.") : error;

	return (
		<div className="sh-connect">
			<div className="sh-ambient" />
			<div className="sh-connect-top">
				<div className="sh-brand">
					<OmpMark />
					<span>NeoPi</span>
					<span className="sh-brand-slash">/</span>
					<span className="sh-brand-app">collab</span>
				</div>
				<div className="sh-header-right">
					<LanguagePicker />
					<ThemeToggle />
				</div>
			</div>
			<form className="sh-connect-card" onSubmit={submit}>
				<div className="sh-connect-head">
					<h1 className="sh-connect-title">Join a live session</h1>
					<p className="sh-connect-sub">
						Watch a NeoPi agent work in real time — transcript, tool calls and subagents — and prompt it from
						here.
					</p>
				</div>
				<label className="sh-field">
					<span className="sh-field-label">{tr("connect.link", "Join link")}</span>
					<input
						className="sh-input sh-input-mono"
						type="text"
						value={link}
						onChange={e => setLink(e.target.value)}
						placeholder="ws://host:port/r/room.key"
						spellCheck={false}
						autoComplete="off"
						autoFocus
					/>
					<span className="sh-field-hint">
						Run <code>/collab</code> in any NeoPi session to get one.
					</span>
				</label>
				<label className="sh-field">
					<span className="sh-field-label">{tr("connect.name", "Display name")}</span>
					<input
						className="sh-input"
						type="text"
						value={name}
						onChange={e => setName(e.target.value)}
						placeholder="guest"
						spellCheck={false}
						autoComplete="off"
						maxLength={32}
					/>
				</label>
				{shown && <div className="sh-connect-error">{shown}</div>}
				<button className="sh-btn sh-btn-primary sh-connect-submit" type="submit">
					{tr("connect.action", "Connect")} <ArrowRight size={14} />
				</button>
				<div className="sh-connect-foot">
					<Lock size={12} />
					End-to-end encrypted. The room key stays in the link and never reaches the relay.
				</div>
			</form>
		</div>
	);
}
