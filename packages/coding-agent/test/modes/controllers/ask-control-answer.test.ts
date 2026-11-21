import { describe, expect, it } from "bun:test";
import type { ExtensionAskDialogQuestion } from "../../../src/extensibility/extensions";
import { controlAnswerToAskResult } from "../../../src/modes/controllers/ask-control-answer";

const single: ExtensionAskDialogQuestion = {
	id: "choice",
	question: "Which option?",
	options: [{ label: "Alpha" }, { label: "BETA" }, { label: "beta" }],
	recommended: 0,
};
const multi: ExtensionAskDialogQuestion = { ...single, id: "many", multi: true };

function expected(question: ExtensionAskDialogQuestion, selectedOptions: string[], extra = {}) {
	return {
		id: question.id,
		question: question.question,
		options: question.options.map(option => option.label),
		multi: question.multi ?? false,
		selectedOptions,
		...extra,
	};
}

describe("controlAnswerToAskResult", () => {
	it.each([
		[0, ["Alpha"], {}],
		[
			{ index: 1, notes: [{ option: "BETA", note: "because" }] },
			["BETA"],
			{ notes: [{ option: "BETA", note: "because" }] },
		],
		[{ indices: [2] }, ["beta"], {}],
		["beta", ["beta"], {}],
		["  BeTa  ", ["BETA"], {}],
		["A custom answer", [], { customInput: "A custom answer" }],
		[
			{ text: "Alpha", notes: [{ note: "literal text" }] },
			[],
			{ customInput: "Alpha", notes: [{ note: "literal text" }] },
		],
		[{ custom: "Other" }, [], { customInput: "Other" }],
	])("normalizes a single answer %j", (value, selectedOptions, extra) => {
		expect(controlAnswerToAskResult([single], value)).toEqual({
			kind: "submit",
			results: [expected(single, selectedOptions as string[], extra)],
		});
	});

	it("selects multiple raw labels and permits an empty multi-selection", () => {
		const notes = [
			{ option: "Alpha", note: "first" },
			{ option: "BETA", note: "not this" },
		];
		expect(controlAnswerToAskResult([multi], { indices: [0, 2], notes })).toEqual({
			kind: "submit",
			results: [expected(multi, ["Alpha", "beta"], { notes })],
		});
		expect(controlAnswerToAskResult([multi], { indices: [] })).toEqual({
			kind: "submit",
			results: [expected(multi, [])],
		});
	});

	it("accepts chat and normalizes full submit metadata from the questions", () => {
		expect(controlAnswerToAskResult([single], { kind: "chat" })).toEqual({ kind: "chat" });
		expect(
			controlAnswerToAskResult([single, multi], {
				kind: "submit",
				results: [
					{
						id: "untrusted",
						question: "wrong",
						options: [],
						multi: true,
						selectedOptions: ["Alpha"],
						notes: [{ option: "Alpha", note: "yes" }],
					},
					{ selectedOptions: [], customInput: "custom" },
				],
			}),
		).toEqual({
			kind: "submit",
			results: [
				expected(single, ["Alpha"], { notes: [{ option: "Alpha", note: "yes" }] }),
				expected(multi, [], { customInput: "custom" }),
			],
		});
	});

	it.each([
		[[{ index: 2 }, { indices: [0, 1], notes: [{ option: "Alpha", note: "together" }] }]],
		{ many: { indices: [0, 1], notes: [{ option: "Alpha", note: "together" }] }, choice: { index: 2 } },
	])("maps multiple questions in order from %j", value => {
		expect(controlAnswerToAskResult([single, multi], value)).toEqual({
			kind: "submit",
			results: [
				expected(single, ["beta"]),
				expected(multi, ["Alpha", "BETA"], { notes: [{ option: "Alpha", note: "together" }] }),
			],
		});
	});

	it.each(
		[
			null,
			undefined,
			true,
			{},
			[],
			-1,
			3,
			0.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			{ index: "0" },
			{ index: null },
			{ indices: [0, 1] },
			{ indices: [] },
			{ indices: "0" },
			{ indices: [-1] },
			{ indices: [3] },
			{ indices: [0.5] },
			{ indices: ["0"] },
			{ text: 1 },
			{ custom: false },
			{ index: 0, note: 1 },
			{ index: 0, notes: [{ option: "unknown", note: "no" }] },
			{
				index: 0,
				notes: [
					{ option: "Alpha", note: "first" },
					{ option: "Alpha", note: "second" },
				],
			},
			{ kind: "submit" },
			{ kind: "submit", results: [] },
			{ kind: "submit", results: [{ selectedOptions: [0] }] },
			{ kind: "submit", results: [{ selectedOptions: "Alpha" }] },
			{ kind: "submit", results: [{ selectedOptions: [], customInput: 1 }] },
			{ kind: "submit", results: [{ selectedOptions: [], note: true }] },
		].map(value => [value]),
	)("rejects invalid single answer %j", value => {
		expect(controlAnswerToAskResult([single], value)).toBeUndefined();
	});

	it.each([0, "Alpha", [0], [0, 1, 2], [0, {}], { choice: 0 }, { choice: 0, many: false }].map(value => [value]))(
		"rejects incomplete or invalid question sets %j",
		value => {
			expect(controlAnswerToAskResult([single, multi], value)).toBeUndefined();
		},
	);
});
