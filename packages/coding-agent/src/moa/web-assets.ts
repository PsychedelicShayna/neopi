/**
 * The browser editor's files, imported as text so a compiled binary serves
 * them without touching the filesystem. `web-server.ts` serves `editorPage`
 * at the capability root and each entry of `editorAssets` under `assets/`.
 */
import page from "./web-editor.html" with { type: "text" };
// @ts-expect-error Bun imports this browser script as source text, not as a JS module.
import script0 from "./web-editor-strings.js" with { type: "text" };
// @ts-expect-error Bun imports this browser script as source text, not as a JS module.
import script1 from "./web-editor-core.js" with { type: "text" };
// @ts-expect-error Bun imports this browser script as source text, not as a JS module.
import script2 from "./web-editor-graph.js" with { type: "text" };
// @ts-expect-error Bun imports this browser script as source text, not as a JS module.
import script3 from "./web-editor-canvas.js" with { type: "text" };
// @ts-expect-error Bun imports this browser script as source text, not as a JS module.
import script4 from "./web-editor-panel.js" with { type: "text" };
// @ts-expect-error Bun imports this browser script as source text, not as a JS module.
import script5 from "./web-editor-sidebar.js" with { type: "text" };
// @ts-expect-error Bun imports this browser script as source text, not as a JS module.
import script6 from "./web-editor-save.js" with { type: "text" };
// @ts-expect-error Bun imports this browser script as source text, not as a JS module.
import script7 from "./web-editor.js" with { type: "text" };

export interface MixtureWebAsset {
	body: string;
	/** The full `Content-Type` value. */
	type: string;
}

const SCRIPT = "text/javascript; charset=utf-8";

// The text attribute overrides Bun's default .html bundle loader.
export const editorPage = page as unknown as string;

/** Keyed by the file name the page requests under `assets/`, in the order the page loads them. */
export const editorAssets: Readonly<Record<string, MixtureWebAsset>> = {
	"web-editor-strings.js": { body: script0, type: SCRIPT },
	"web-editor-core.js": { body: script1, type: SCRIPT },
	"web-editor-graph.js": { body: script2, type: SCRIPT },
	"web-editor-canvas.js": { body: script3, type: SCRIPT },
	"web-editor-panel.js": { body: script4, type: SCRIPT },
	"web-editor-sidebar.js": { body: script5, type: SCRIPT },
	"web-editor-save.js": { body: script6, type: SCRIPT },
	"web-editor.js": { body: script7, type: SCRIPT },
};
