import { describe, expect, it } from "bun:test";
import { transcribeAudio, TranscriptionApiError } from "@oh-my-pi/pi-ai/transcription";
import type { ApiKeyResolveContext } from "@oh-my-pi/pi-ai/auth-retry";
import { ProviderResponseError } from "@oh-my-pi/pi-ai/error";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";

function xaiModel(id = "grok-stt", baseUrl = "https://api.x.ai/v1"): Model<"xai-stt"> {
	return buildModel({
		id,
		name: "Grok STT",
		api: "xai-stt",
		provider: "xai",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
		kind: "stt",
	} satisfies ModelSpec<"xai-stt">);
}

const request = {
	audio: new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46])], { type: "audio/wav" }),
	mimeType: "audio/wav",
	fileName: "dictation.wav",
	language: " en ",
	responseFormat: "json" as const,
};

describe("xAI native transcription", () => {
	it("dispatches the selected model to /stt with model before the disk-backed audio part", async () => {
		const model = xaiModel("grok-stt-selected", "https://speech.example/v1///");
		const fetchImpl: FetchImpl = async (input, init) => {
			expect(String(input)).toBe("https://speech.example/v1/stt");
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer selected-credential");
			if (!(init?.body instanceof FormData)) throw new Error("Expected multipart body");
			expect([...init.body.keys()]).toEqual(["model", "file", "language"]);
			expect(init.body.get("model")).toBe("grok-stt-selected");
			expect(init.body.get("language")).toBe("en");
			const file = init.body.get("file");
			if (!(file instanceof File)) throw new Error("Expected audio File");
			expect({ name: file.name, type: file.type, size: file.size }).toEqual({
				name: "dictation.wav",
				type: "audio/wav",
				size: 4,
			});
			return Response.json({ text: "  native transcript  " });
		};

		const result = await transcribeAudio(model, request, { apiKey: "selected-credential", fetch: fetchImpl });
		expect(result).toEqual({
			text: "native transcript",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
	});

	it("turns a 401 transport response into an auth retry boundary", async () => {
		const resolutions: ApiKeyResolveContext[] = [];
		const authorizations: Array<string | null> = [];
		const fetchImpl: FetchImpl = async (_input, init) => {
			authorizations.push(new Headers(init?.headers).get("authorization"));
			if (authorizations.length === 1) {
				return Response.json(
					{ error: { message: "expired bearer", code: "invalid_token" } },
					{ status: 401, headers: { "x-request-id": "first" } },
				);
			}
			return Response.json({ text: "retried transcript" });
		};
		let resolution = 0;
		const result = await transcribeAudio(xaiModel(), request, {
			apiKey: context => {
				resolutions.push(context);
				return resolution++ === 0 ? "expired" : "refreshed";
			},
			fetch: fetchImpl,
		});

		expect(result.text).toBe("retried transcript");
		expect(authorizations).toEqual(["Bearer expired", "Bearer refreshed"]);
		expect(resolutions).toHaveLength(2);
		expect(resolutions[1]?.lastChance).toBe(false);
		expect(resolutions[1]?.previousKey).toBe("expired");
		expect(resolutions[1]?.error).toBeInstanceOf(TranscriptionApiError);
		expect(resolutions[1]?.error).toMatchObject({ status: 401, code: "invalid_token" });
	});

	it("rejects malformed successful responses as provider response errors", async () => {
		await expect(
			transcribeAudio(xaiModel(), request, {
				apiKey: "key",
				fetch: async () => Response.json({ transcript: "wrong field" }),
			}),
		).rejects.toBeInstanceOf(ProviderResponseError);
	});
});
