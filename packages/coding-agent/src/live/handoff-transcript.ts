// Frameless Bidi transcript assembly and handoff format follow openai/codex
// 1145028, codex-api/src/endpoint/realtime_websocket/methods.rs and
// core/src/context/realtime_delegation.rs (Apache-2.0).
type Speaker = "user" | "assistant";

interface TranscriptTurn {
	sequence: number;
	role: Speaker;
	text: string;
}

const FIELD_BYTES = 4096;

function escapeXml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function boundedXml(text: string): string {
	const bytes = Buffer.from(escapeXml(text));
	if (bytes.length <= FIELD_BYTES) return bytes.toString();
	let end = FIELD_BYTES - Buffer.byteLength("…");
	while ((bytes[end]! & 0xc0) === 0x80) end--;
	return `${bytes.subarray(0, end).toString()}…`;
}

/** Active Frameless Bidi entries in first-observed order, with one open entry per speaker. */
export class LiveHandoffTranscript {
	#sequence = 0;
	#turns: TranscriptTurn[] = [];
	#open = new Map<Speaker, TranscriptTurn>();
	#flushedUserInputs = new Set<string>();

	#append(role: Speaker, text: string): TranscriptTurn {
		const turn = { sequence: ++this.#sequence, role, text };
		this.#turns.push(turn);
		return turn;
	}

	delta(role: Speaker, text: string): void {
		if (!text) return;
		const current = this.#open.get(role);
		if (current) current.text += text;
		else this.#open.set(role, this.#append(role, text));
	}

	done(role: Speaker, text: string): void {
		const current = this.#open.get(role);
		if (text) {
			if (!current) this.#append(role, text);
			else if (text.startsWith(current.text)) current.text = text;
		}
		this.#open.delete(role);
	}

	completed(): readonly TranscriptTurn[] {
		const bytes = this.#turns.reduce((sum, turn) => sum + Buffer.byteLength(turn.role + turn.text) + 3, 0);
		if (bytes <= FIELD_BYTES) return [];
		const firstOpen = Math.min(...[...this.#open.values()].map(turn => turn.sequence));
		return this.#turns.filter(turn => turn.sequence < firstOpen);
	}

	tail(): readonly TranscriptTurn[] {
		return [...this.#turns];
	}

	formatContext(entries: readonly TranscriptTurn[], tail: boolean): string {
		const delta = this.#format(entries);
		return `<realtime_delegation>\n  <source>${tail ? "transcript_tail_flush" : "transcript_flush"}</source>\n  <transcript_delta>${escapeXml(delta)}</transcript_delta>\n</realtime_delegation>`;
	}

	#format(entries: readonly { role: Speaker; text: string }[]): string {
		return entries.map(({ role, text }) => `${role}: ${text}`).join("\n");
	}

	snapshot(input: string): { through: number; content: string } {
		const entries = this.#turns.map(({ role, text }) => ({ role, text }));
		const trimmed = input.trim();
		if (
			trimmed &&
			!this.#flushedUserInputs.has(trimmed) &&
			!entries.some(entry => entry.role === "user" && entry.text.trim() === trimmed)
		) {
			entries.push({ role: "user", text: trimmed });
		}
		const delta = this.#format(entries);
		return {
			through: this.#sequence,
			content: `<realtime_delegation>\n  <input>${boundedXml(input || delta)}</input>\n${delta ? `  <transcript_delta>${escapeXml(delta)}</transcript_delta>\n` : ""}</realtime_delegation>`,
		};
	}

	flushed(entries: readonly TranscriptTurn[]): void {
		for (const entry of entries) {
			if (entry.role === "user") this.#flushedUserInputs.add(entry.text.trim());
		}
		const last = entries.at(-1);
		if (last) this.#dropThrough(last.sequence);
	}

	accept(through: number): void {
		this.#flushedUserInputs.clear();
		this.#dropThrough(through);
	}

	#dropThrough(through: number): void {
		this.#turns = this.#turns.filter(turn => turn.sequence > through);
		for (const [role, turn] of this.#open) {
			if (turn.sequence <= through) this.#open.delete(role);
		}
	}
}
