import { describe, expect, it } from "bun:test";
import { getLocale, setLocale } from "@oh-my-pi/pi-utils/i18n";
import { parseStandaloneStatsArgs } from "../src/index";
import { formatStatsDashboardUrl, handleApi } from "../src/server";

describe("standalone stats CLI", () => {
	it("keeps the production parser loopback-only by default", () => {
		expect(parseStandaloneStatsArgs([])).toEqual({
			port: 3847,
			host: "127.0.0.1",
			json: false,
			sync: false,
			help: false,
		});
	});

	it("forwards explicit bind hosts and formats IPv6 dashboard URLs", () => {
		expect(parseStandaloneStatsArgs(["--host", "::", "--port", "3850"])).toMatchObject({
			port: 3850,
			host: "::",
		});
		expect(formatStatsDashboardUrl("::", 3850)).toBe("http://[::]:3850");
		expect(formatStatsDashboardUrl("2001:db8::1", 3850)).toBe("http://[2001:db8::1]:3850");
	});

	it("reports the dashboard language and keeps a launcher's locale in trace URLs", async () => {
		const previous = getLocale();
		try {
			setLocale("es");
			const response = await handleApi(new Request("http://localhost/api/locale"));
			expect(await response.json()).toEqual({ locale: "es" });
			expect(response.headers.get("cache-control")).toBe("no-store");
			const url = new URL(`${formatStatsDashboardUrl("::1", 3850, "en")}#/traces?s=example`);
			expect(url.searchParams.get("lang")).toBe("en");
			expect(url.hash).toBe("#/traces?s=example");
		} finally {
			setLocale(previous);
		}
	});
});
