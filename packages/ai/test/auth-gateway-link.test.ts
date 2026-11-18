import { describe, expect, it } from "bun:test";
import {
	authGatewayLinkBaseUrl,
	defaultAuthGatewayLinkHost,
	formatAuthGatewayLink,
	parseAuthGatewayLink,
	pickLanAddress,
} from "@oh-my-pi/pi-ai/auth-gateway";

const v4 = (address: string, internal = false) => ({ address, family: "IPv4", internal });

describe("auth-gateway connection links", () => {
	it("formats host, port, token and name", () => {
		expect(formatAuthGatewayLink({ host: "192.168.1.31", port: 4000, token: "Zq3_-x8", name: "blackswan" })).toBe(
			"neopi-gateway://192.168.1.31:4000?token=Zq3_-x8&name=blackswan",
		);
	});

	it("round-trips IPv6 hosts, encoded names, base paths and TLS", () => {
		const link = { host: "fd7a::1", port: 443, token: "a+b/c=", name: "office box", basePath: "/npi", tls: true };
		const text = formatAuthGatewayLink(link);
		expect(text).toBe("neopi-gateway://[fd7a::1]:443/npi?token=a%2Bb%2Fc%3D&name=office+box&tls=1");
		expect(parseAuthGatewayLink(text)).toEqual(link);
		expect(authGatewayLinkBaseUrl(link)).toBe("https://[fd7a::1]:443/npi");
	});

	it("defaults a missing port and ignores unknown parameters", () => {
		const link = parseAuthGatewayLink(" neopi-gateway://gateway.lan?token=t&future=x ");
		expect(link).toEqual({ host: "gateway.lan", port: 4000, token: "t" });
		expect(authGatewayLinkBaseUrl(link)).toBe("http://gateway.lan:4000");
	});

	it("rejects links that cannot pair", () => {
		expect(() => parseAuthGatewayLink("http://h:4000?token=t")).toThrow(/scheme/);
		expect(() => parseAuthGatewayLink("neopi-gateway://h:4000?name=n")).toThrow(/token/);
		expect(() => parseAuthGatewayLink("neopi-gateway://u:p@h:4000?token=t")).toThrow(/user info/);
		expect(() => parseAuthGatewayLink("not a link")).toThrow(/Not a gateway link/);
		expect(() => formatAuthGatewayLink({ host: "h", port: 0, token: "t" })).toThrow(/port/);
		expect(() => formatAuthGatewayLink({ host: "h", port: 4000, token: "" })).toThrow(/token/);
	});

	it("names the LAN address for a gateway bound to every interface", () => {
		const interfaces = {
			lo: [v4("127.0.0.1", true)],
			docker0: [v4("172.17.0.1")],
			tailscale0: [v4("100.87.91.89")],
			enp7s0: [{ address: "fe80::1", family: "IPv6", internal: false }, v4("192.168.1.31")],
		};
		expect(pickLanAddress(interfaces)).toBe("192.168.1.31");
		expect(defaultAuthGatewayLinkHost("0.0.0.0", interfaces, "blackswan")).toBe("192.168.1.31");
		expect(defaultAuthGatewayLinkHost("127.0.0.1", interfaces, "blackswan")).toBe("127.0.0.1");
		expect(defaultAuthGatewayLinkHost("::", { tailscale0: [v4("100.87.91.89")] }, "blackswan")).toBe("100.87.91.89");
		expect(defaultAuthGatewayLinkHost("0.0.0.0", { lo: [v4("127.0.0.1", true)] }, "blackswan")).toBe("blackswan");
	});
});
