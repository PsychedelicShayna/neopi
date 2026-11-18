import { describe, expect, it, vi } from "bun:test";
import { pollOAuthDeviceCodeFlow } from "@oh-my-pi/pi-ai/oauth";
import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import { createDeviceCodeLogin } from "../src/registry/engine/device-code";
import type { OAuthAuthInfo } from "../src/registry/oauth/types";

describe("OAuth device-code polling", () => {
	it("exports the legacy device-code poll helper for external providers", async () => {
		const value = await pollOAuthDeviceCodeFlow({
			poll: () => ({ status: "complete", value: { access: "token" } }),
		});

		expect(value).toEqual({ access: "token" });
	});

	it("surfaces provider failure messages", async () => {
		await expect(
			pollOAuthDeviceCodeFlow({
				poll: () => ({ status: "failed", message: "authorization denied" }),
			}),
		).rejects.toThrow("authorization denied");
	});

	it("keeps a successful poll that finishes after the deadline", async () => {
		let now = 1_000;
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		try {
			const value = await pollOAuthDeviceCodeFlow({
				expiresInSeconds: 1,
				poll: () => {
					now = 2_001;
					return { status: "complete", value: "authorized" };
				},
			});
			expect(value).toBe("authorized");
		} finally {
			clock.mockRestore();
		}
	});

	it("prefers caller cancellation over a completed poll", async () => {
		const controller = new AbortController();
		await expect(
			pollOAuthDeviceCodeFlow({
				signal: controller.signal,
				poll: () => {
					controller.abort();
					return { status: "complete", value: "authorized" };
				},
			}),
		).rejects.toThrow("Login cancelled");
	});

	it("cancels an in-flight poll when the caller aborts instead of waiting for the provider", async () => {
		const controller = new AbortController();
		const flow = pollOAuthDeviceCodeFlow({
			signal: controller.signal,
			poll: signal =>
				new Promise<never>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
					controller.abort();
				}),
		});
		await expect(flow).rejects.toThrow("Login cancelled");
	});

	it("times out pending device flows", async () => {
		await expect(
			pollOAuthDeviceCodeFlow({
				expiresInSeconds: 0.001,
				poll: () => ({ status: "pending" }),
			}),
		).rejects.toThrow("Device flow timed out");
	});

	it("publishes the actual user code without exposing the private polling code or parsing instructions", async () => {
		const policy = authPolicyFor("factory-droid")?.login;
		if (policy?.kind !== "device-code") throw new Error("Missing native device-code policy");
		const controller = new AbortController();
		const auth: OAuthAuthInfo[] = [];
		const login = createDeviceCodeLogin(
			{ ...policy, instructions: "Finish signing in at the verification URL" },
			"factory-droid",
		);
		await expect(
			login({
				signal: controller.signal,
				fetch: (async () =>
					Response.json({
						user_code: "ACTUAL-USER-CODE",
						device_code: "private-polling-secret",
						verification_uri: "https://example.com/verify",
						interval: 0,
						expires_in: 60,
					})) as typeof fetch,
				onAuth: info => {
					auth.push(info);
					controller.abort();
				},
			}),
		).rejects.toThrow("Login cancelled");
		expect(auth).toEqual([
			{
				url: "https://example.com/verify",
				userCode: "ACTUAL-USER-CODE",
				instructions: "Finish signing in at the verification URL",
			},
		]);
		expect(JSON.stringify(auth)).not.toContain("private-polling-secret");
	});
});
