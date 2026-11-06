import { afterEach, expect, mock, test } from "bun:test";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Routine } from "@npi-deck/protocol";
import { routinesApi } from "@/lib/routines-api";
import { LegacyRoutineBuilder } from "./LegacyRoutineBuilder";
import type { RoutineBuilderHandle, RoutineBuilderState } from "./RoutineBuilder";
import { stringifySpec } from "./spec-toml";

const originalUpdate = routinesApi.update;
let renderer: ReactTestRenderer | undefined;
afterEach(() => {
	if (renderer) act(() => renderer!.unmount());
	renderer = undefined;
	routinesApi.update = originalUpdate;
});

function unavailable(): Routine {
	return {
		id: "blocked",
		name: "blocked",
		description: "Original description",
		cron: "",
		actionKind: "script",
		actionBody: "",
		enabled: true,
		createdAt: "",
		updatedAt: "",
		specVersion: 1,
		concurrency: "skip",
		specImportError: "Original YAML cannot be imported losslessly.",
	};
}

test("failed legacy imports expose an empty native repair editor without fake form or run controls", () => {
	const html = renderToStaticMarkup(
		<LegacyRoutineBuilder routine={unavailable()} onSaved={() => {}} onError={() => {}} />,
	);
	expect(html).toContain('role="alert"');
	expect(html).toContain('aria-label="Routine TOML repair source"');
	expect(html).toContain("Save TOML replacement");
	expect(html).not.toContain('aria-label="Routine name"');
	expect(html).not.toContain("Run now");
	expect(html).not.toContain("untitled-routine");
	expect(html).not.toContain("[[steps]]");
});

test("repair validates native TOML then updates the same routine through the existing save interface", async () => {
	const routine = unavailable();
	const update = mock(async (id: string, body: Parameters<typeof originalUpdate>[1]): Promise<Routine> => ({
		...routine,
		id,
		name: body.name ?? routine.name,
		specToml: body.specToml,
		specImportError: undefined,
	}));
	routinesApi.update = update;
	const saved = mock((_routine: Routine) => {});
	const errors = mock((_message: string) => {});
	const handle = createRef<RoutineBuilderHandle>();
	const state: { current?: RoutineBuilderState } = {};
	const captureState = (next: RoutineBuilderState) => {
		state.current = next;
	};
	await act(async () => {
		renderer = create(
			<LegacyRoutineBuilder
				routine={routine}
				onSaved={saved}
				onError={errors}
				editorRef={handle}
				onStateChange={captureState}
			/>,
		);
	});
	expect(renderer!.root.findByType("textarea").props.value).toBe("");
	expect(renderer!.root.findByType("button").props.disabled).toBe(true);
	expect(state.current?.canSave).toBe(false);
	expect(state.current?.spec).toBeUndefined();
	await act(async () => {
		renderer!.root.findByType("textarea").props.onChange({ target: { value: "name: not-native" } });
	});
	await act(async () => {
		await handle.current!.save();
	});
	expect(update).not.toHaveBeenCalled();
	expect(errors).toHaveBeenCalled();
	const source = stringifySpec({
		name: "repaired",
		trigger: [{ manual: {} }],
		steps: [{ id: "wait", type: "wait", duration_secs: 1 }],
	});
	await act(async () => {
		renderer!.root.findByType("textarea").props.onChange({ target: { value: source } });
	});
	expect(renderer!.root.findByType("button").props.disabled).toBe(false);
	expect(state.current?.canSave).toBe(true);
	await act(async () => {
		await handle.current!.save();
	});
	expect(update).toHaveBeenCalledWith(routine.id, { name: "repaired", specToml: source });
	expect(saved).toHaveBeenCalledTimes(1);
	expect(saved.mock.calls[0]![0]).toMatchObject({ id: routine.id, specToml: source });
	expect(saved.mock.calls[0]![0].specImportError).toBeUndefined();
});
