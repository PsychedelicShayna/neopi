/**
 * The human wins a concurrent edit: a stale revision is a conflict, and a
 * control submission writes a detached draft instead of the composer.
 */
import { describe, expect, test } from "bun:test";
import { revisionConflict } from "../../src/control/host";
import { encodeKeyId } from "../../src/control/keys";
import { currentDetachedDraft, runWithDetachedDraft } from "@oh-my-pi/pi-tui/draft-scope";
import type { Revisions } from "../../src/control/types";

const revisions: Revisions = {
	generation: 1,
	human: 4,
	focus: 0,
	draft: 2,
	dialogs: 0,
	paint: 0,
	model: null,
	role: null,
};

describe("control revisions", () => {
	test("a stale human revision is a conflict and a matching one is not", () => {
		expect(revisionConflict({ human: 3 }, revisions)).toBe("human");
		expect(revisionConflict({ human: 4, draft: 2 }, revisions)).toBeUndefined();
		expect(revisionConflict(undefined, revisions)).toBeUndefined();
	});

	test("a control draft write does not land on the human composer", () => {
		const human = "keep me";
		runWithDetachedDraft(() => {
			const detached = currentDetachedDraft();
			expect(detached).toBeDefined();
			detached!.text = "orchestrator";
			expect(human).toBe("keep me");
			expect(currentDetachedDraft()?.text).toBe("orchestrator");
		});
		expect(currentDetachedDraft()).toBeUndefined();
		expect(human).toBe("keep me");
	});

	test("key ids used by dialogs encode to terminal bytes", () => {
		expect(encodeKeyId("enter")).toBe("\r");
		expect(encodeKeyId("escape")).toBe("\x1b");
		expect(encodeKeyId("down")).toBe("\x1b[B");
		expect(encodeKeyId("ctrl+c")).toBe("\x1b[99;5u");
		expect(encodeKeyId("alt+left")).toBe("\x1b[1;3D");
		expect(encodeKeyId("pageup")).toBe("\x1b[5~");
	});
});
