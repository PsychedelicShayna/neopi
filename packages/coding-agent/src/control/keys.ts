/**
 * Encode a canonical key id (`ctrl+shift+o`) as terminal bytes (#171).
 *
 * Modified keys use CSI-u, which `parseKey` decodes whether or not the kitty
 * protocol is active. Unmodified keys use legacy bytes.
 */
const SPECIAL: Record<string, { code: number; legacy: string }> = {
	escape: { code: 27, legacy: "\x1b" },
	esc: { code: 27, legacy: "\x1b" },
	enter: { code: 13, legacy: "\r" },
	return: { code: 13, legacy: "\r" },
	tab: { code: 9, legacy: "\t" },
	space: { code: 32, legacy: " " },
	backspace: { code: 127, legacy: "\x7f" },
	delete: { code: 127, legacy: "\x1b[3~" },
	up: { code: 0, legacy: "\x1b[A" },
	down: { code: 0, legacy: "\x1b[B" },
	right: { code: 0, legacy: "\x1b[C" },
	left: { code: 0, legacy: "\x1b[D" },
	home: { code: 0, legacy: "\x1b[H" },
	end: { code: 0, legacy: "\x1b[F" },
	pageup: { code: 0, legacy: "\x1b[5~" },
	pagedown: { code: 0, legacy: "\x1b[6~" },
};

const MOD_BITS: Record<string, number> = { shift: 1, alt: 2, ctrl: 4, super: 8 };

/** Encode one key id, or undefined when it has no representation. */
export function encodeKeyId(id: string): string | undefined {
	const parts = id.toLowerCase().split("+");
	const key = parts.pop();
	if (!key) return undefined;
	let bits = 0;
	for (const part of parts) {
		const bit = MOD_BITS[part];
		if (bit === undefined) return undefined;
		bits |= bit;
	}
	if (bits === 0) {
		if (key.length === 1) return key;
		return SPECIAL[key]?.legacy;
	}
	const mod = bits + 1;
	const xterm: Record<string, string> = {
		up: `\x1b[1;${mod}A`,
		down: `\x1b[1;${mod}B`,
		right: `\x1b[1;${mod}C`,
		left: `\x1b[1;${mod}D`,
		home: `\x1b[1;${mod}H`,
		end: `\x1b[1;${mod}F`,
		pageup: `\x1b[5;${mod}~`,
		pagedown: `\x1b[6;${mod}~`,
	};
	const named = key.toLowerCase();
	if (xterm[named]) return xterm[named];
	const code = key.length === 1 ? key.codePointAt(0)! : SPECIAL[key]?.code;
	if (!code) return undefined;
	return `\x1b[${code};${mod}u`;
}

/** Encode one SGR mouse report. Coordinates are 0-based, matching the parser. */
export function encodeSgrMouse(
	x: number,
	y: number,
	action: "click" | "press" | "release" | "scrollUp" | "scrollDown" | "move" = "click",
): string {
	const col = Math.max(0, Math.trunc(x)) + 1;
	const row = Math.max(0, Math.trunc(y)) + 1;
	const button = action === "scrollUp" ? 64 : action === "scrollDown" ? 65 : action === "move" ? 35 : 0;
	const suffix = action === "release" ? "m" : "M";
	return `\x1b[<${button};${col};${row}${suffix}`;
}
