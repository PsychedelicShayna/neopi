import { expect, it } from "bun:test";
import type { Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Agent } from "../src/agent";

it("uses each request's active model variant without leaking settings into the next model", async () => {
	const mock = createMockModel({ handler: { content: ["Done"] } });
	const variant: Model = {
		...mock.model,
		id: "my-profile",
		variant: {
			baseModelId: mock.model.id,
			settings: {},
			request: { temperature: -1, topP: 0, serviceTier: "none", hideThinkingSummary: true },
		},
	};
	const credentialModels: string[] = [];
	const requests: Array<{ id: string; options?: SimpleStreamOptions }> = [];
	const agent = new Agent({
		initialState: { model: variant },
		temperature: 0.8,
		topP: 0.9,
		serviceTier: "priority",
		getApiKey: model => {
			credentialModels.push(model.id);
			return "fixture";
		},
		streamFn: (model, context, options) => {
			requests.push({ id: model.id, options });
			return mock.stream(model, context, options);
		},
	});

	await agent.prompt("First");
	agent.setModel(mock.model);
	await agent.prompt("Next");

	expect(credentialModels).toEqual([mock.model.id, mock.model.id]);
	expect(requests.map(request => request.id)).toEqual([variant.id, mock.model.id]);
	expect(requests[0]?.options).toMatchObject({
		temperature: undefined,
		topP: 0,
		serviceTier: undefined,
		hideThinkingSummary: true,
	});
	expect(requests[1]?.options).toMatchObject({ temperature: 0.8, topP: 0.9, serviceTier: "priority" });
});
