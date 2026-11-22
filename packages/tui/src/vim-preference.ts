let enabled = false;

/** Follow the host's live Vim preference in both menu navigation and text editing. */
export function setMenuSearchVimMode(value: boolean): void {
	enabled = value;
}

export function getMenuSearchVimMode(): boolean {
	return enabled;
}
