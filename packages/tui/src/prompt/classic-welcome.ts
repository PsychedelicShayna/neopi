import { PRODUCT_NAME } from "@oh-my-pi/pi-utils/dirs";
import { t } from "@oh-my-pi/pi-utils/i18n";
import { theme } from "../theme/theme";
import { padding, truncateToWidth, visibleWidth } from "../utils";

/**
 * Classic boxed layout recovered from ac5b9226bb0839c66ec881e76be5b78a83b9e889,
 * packages/tui/src/prompt/welcome.ts. The Pi art is supplied unchanged by the
 * shared welcome animation. Removed model, LSP and recent-session welcome
 * inputs are not restored; the right column keeps the original shortcuts.
 */
export function renderClassicWelcome(
	termWidth: number,
	version: string,
	logoColored: readonly string[],
	renderTip: (width: number) => string[],
): string[] {
	// Box dimensions - responsive with max width and small-terminal support
	const maxWidth = 100;
	const boxWidth = Math.min(maxWidth, Math.max(0, termWidth - 2));
	if (boxWidth < 4) {
		return [];
	}
	const dualContentWidth = boxWidth - 3; // 3 = │ + │ + │
	const preferredLeftCol = 26;
	const minLeftCol = 12; // logo width
	const minRightCol = 20;
	const leftMinContentWidth = Math.max(minLeftCol, visibleWidth(t("tui.welcome.greeting")));
	const desiredLeftCol = Math.max(
		Math.min(preferredLeftCol, Math.max(minLeftCol, Math.floor(dualContentWidth * 0.35))),
		leftMinContentWidth,
	);
	const dualLeftCol =
		dualContentWidth >= minRightCol + 1
			? Math.min(desiredLeftCol, dualContentWidth - minRightCol)
			: Math.max(1, dualContentWidth - 1);
	const dualRightCol = Math.max(1, dualContentWidth - dualLeftCol);
	const showRightColumn = dualLeftCol >= leftMinContentWidth && dualRightCol >= minRightCol;
	const leftCol = showRightColumn ? dualLeftCol : boxWidth - 2;
	const rightCol = showRightColumn ? dualRightCol : 0;

	// Left column - centered content
	const leftLines = [
		"",
		centerText(theme.bold(t("tui.welcome.greeting")), leftCol),
		"",
		...logoColored.map(l => centerText(l, leftCol)),
		"",
	];

	// Right column
	const rightLines = [
		` ${theme.bold(theme.fg("accent", t("tui.welcome.tips")))}`,
		` ${theme.fg("dim", "#")}${theme.fg("muted", " for prompt actions")}`,
		` ${theme.fg("dim", "/")}${theme.fg("muted", " for commands")}`,
		` ${theme.fg("dim", "!")}${theme.fg("muted", t("tui.welcome.bash_suffix"))}`,
		` ${theme.fg("dim", "$")}${theme.fg("muted", t("tui.welcome.python_suffix"))}`,
	];

	// Border characters (dim)
	const hChar = theme.boxRound.horizontal;
	const h = theme.fg("dim", hChar);
	const v = theme.fg("dim", theme.boxRound.vertical);
	const tl = theme.fg("dim", theme.boxRound.topLeft);
	const tr = theme.fg("dim", theme.boxRound.topRight);
	const bl = theme.fg("dim", theme.boxRound.bottomLeft);
	const br = theme.fg("dim", theme.boxRound.bottomRight);

	const lines: string[] = [];

	// Top border with embedded title
	const title = ` ${PRODUCT_NAME} v${version} `;
	const titlePrefixRaw = hChar.repeat(3);
	const titleStyled = theme.fg("dim", titlePrefixRaw) + theme.fg("muted", title);
	const titleVisLen = visibleWidth(titlePrefixRaw) + visibleWidth(title);
	const titleSpace = boxWidth - 2;
	if (titleVisLen >= titleSpace) {
		lines.push(tl + truncateToWidth(titleStyled, titleSpace) + tr);
	} else {
		const afterTitle = titleSpace - titleVisLen;
		lines.push(tl + titleStyled + theme.fg("dim", hChar.repeat(afterTitle)) + tr);
	}

	// Content rows
	const maxRows = showRightColumn ? Math.max(leftLines.length, rightLines.length) : leftLines.length;
	for (let i = 0; i < maxRows; i++) {
		const left = fitToWidth(leftLines[i] ?? "", leftCol);
		if (showRightColumn) {
			const right = fitToWidth(rightLines[i] ?? "", rightCol);
			lines.push(v + left + v + right + v);
		} else {
			lines.push(v + left + v);
		}
	}
	// Bottom border
	if (showRightColumn) {
		lines.push(bl + h.repeat(leftCol) + theme.fg("dim", theme.boxRound.teeUp) + h.repeat(rightCol) + br);
	} else {
		lines.push(bl + h.repeat(leftCol) + br);
	}

	// Randomly picked tip, rendered directly beneath the box.
	lines.push(...renderTip(boxWidth));

	return lines;
}

/** Center text within a given width. */
function centerText(text: string, width: number): string {
	const visLen = visibleWidth(text);
	if (visLen >= width) {
		return truncateToWidth(text, width);
	}
	const leftPad = Math.floor((width - visLen) / 2);
	const rightPad = width - visLen - leftPad;
	return padding(leftPad) + text + padding(rightPad);
}

/** Fit string to exact width with ANSI-aware truncation/padding. */
function fitToWidth(str: string, width: number): string {
	const fitted = truncateToWidth(str, width);
	return fitted + padding(Math.max(0, width - visibleWidth(fitted)));
}
