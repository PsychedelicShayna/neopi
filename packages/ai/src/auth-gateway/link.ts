/**
 * Connection links for a running auth-gateway.
 *
 * A link carries everything another program (NeoProxy, another NeoPi) needs to
 * call this gateway, so pairing is one paste instead of an address, a token and
 * a name typed separately:
 *
 *   neopi-gateway://<host>:<port>[/<base-path>]?token=<bearer>&name=<name>[&tls=1]
 *
 * - `host`, `port`: where the caller reaches the gateway (IPv6 in brackets).
 *   The port is always written; a parser defaults a missing one to 4000.
 * - `/<base-path>`: optional prefix for a gateway behind a reverse proxy.
 * - `token`: the gateway bearer, URL-encoded. Required for pairing; the link is
 *   therefore a secret.
 * - `name`: human label for the gateway (the host's hostname by default).
 * - `tls=1`: call the gateway over HTTPS (a TLS-terminating reverse proxy);
 *   without it the gateway is plain HTTP.
 *
 * Unknown query parameters are ignored so the format can grow.
 */

export const AUTH_GATEWAY_LINK_SCHEME = "neopi-gateway";

const DEFAULT_LINK_PORT = 4000;

export interface AuthGatewayLink {
	/** Host clients connect to: a DNS name, IPv4 address or bare IPv6 address (no brackets). */
	host: string;
	port: number;
	/** Gateway bearer token. */
	token: string;
	/** Human label for the gateway. */
	name?: string;
	/** Reverse-proxy prefix, `/`-led without a trailing `/`; empty for the root. */
	basePath?: string;
	/** Reach the gateway over HTTPS. */
	tls?: boolean;
}

function formatHost(host: string): string {
	return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function normalizeBasePath(basePath: string | undefined): string {
	if (!basePath) return "";
	const trimmed = basePath.replace(/\/+$/, "");
	if (trimmed === "") return "";
	return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** Format a connection link. Throws on an empty host or token, or a port outside 1-65535. */
export function formatAuthGatewayLink(link: AuthGatewayLink): string {
	const host = link.host.trim();
	if (host === "") throw new Error("Gateway link needs a host.");
	if (!Number.isInteger(link.port) || link.port < 1 || link.port > 65535) {
		throw new Error(`Gateway link port must be 1-65535, got ${link.port}.`);
	}
	if (link.token === "") throw new Error("Gateway link needs the gateway bearer token.");
	const params = new URLSearchParams({ token: link.token });
	if (link.name) params.set("name", link.name);
	if (link.tls) params.set("tls", "1");
	return `${AUTH_GATEWAY_LINK_SCHEME}://${formatHost(host)}:${link.port}${normalizeBasePath(link.basePath)}?${params}`;
}

/** Parse a connection link. Throws with a readable message when it is not a usable gateway link. */
export function parseAuthGatewayLink(raw: string): AuthGatewayLink {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new Error("Not a gateway link: expected neopi-gateway://host:port?token=…");
	}
	if (url.protocol !== `${AUTH_GATEWAY_LINK_SCHEME}:`) {
		throw new Error(`Not a gateway link: the scheme must be ${AUTH_GATEWAY_LINK_SCHEME}://`);
	}
	if (url.username || url.password) throw new Error("Gateway link must not carry user info.");
	const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
	if (host === "") throw new Error("Gateway link has no host.");
	const port = url.port === "" ? DEFAULT_LINK_PORT : Number(url.port);
	const token = url.searchParams.get("token") ?? "";
	if (token === "") throw new Error("Gateway link has no token.");
	const name = url.searchParams.get("name") || undefined;
	const basePath = normalizeBasePath(url.pathname);
	const tls = url.searchParams.get("tls") === "1";
	return { host, port, token, ...(name ? { name } : {}), ...(basePath ? { basePath } : {}), ...(tls ? { tls } : {}) };
}

/** The HTTP(S) base URL a link points at, e.g. `http://192.168.1.31:4000`. */
export function authGatewayLinkBaseUrl(link: AuthGatewayLink): string {
	return `${link.tls ? "https" : "http"}://${formatHost(link.host)}:${link.port}${normalizeBasePath(link.basePath)}`;
}

/** Hosts a listener binds to all interfaces with. */
export function isWildcardHost(host: string): boolean {
	return host === "" || host === "0.0.0.0" || host === "::" || host === "[::]";
}

/** Loopback hosts other machines cannot reach. */
export function isLoopbackHost(host: string): boolean {
	return host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127.");
}

/** Minimal shape of `os.networkInterfaces()` entries the LAN pick reads. */
export interface LanInterfaceAddress {
	address: string;
	family: string | number;
	internal: boolean;
}

// Container bridges, hypervisor networks and overlay VPNs: reachable from this
// host, rarely what another machine on the office LAN uses.
const VIRTUAL_INTERFACE_RE =
	/^(lo|docker|br-|veth|virbr|vmnet|vboxnet|zt|tailscale|wg|tun|tap|utun|cni|flannel|podman|lxc|lxd)/;

function isPrivateIPv4(address: string): boolean {
	return address.startsWith("10.") || address.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(address);
}

/**
 * The address other machines on the LAN most likely use for this host: a
 * private IPv4 on a physical interface, else any external IPv4, else
 * `undefined`.
 */
export function pickLanAddress(
	interfaces: Readonly<Record<string, readonly LanInterfaceAddress[] | undefined>>,
): string | undefined {
	let fallback: string | undefined;
	for (const [name, addresses] of Object.entries(interfaces)) {
		for (const entry of addresses ?? []) {
			if (entry.internal || (entry.family !== "IPv4" && entry.family !== 4)) continue;
			if (!VIRTUAL_INTERFACE_RE.test(name) && isPrivateIPv4(entry.address)) return entry.address;
			fallback ??= entry.address;
		}
	}
	return fallback;
}

/**
 * Host a link names by default: the bind host itself, or for a gateway bound
 * to all interfaces the machine's LAN address (its hostname when it has none).
 */
export function defaultAuthGatewayLinkHost(
	bindHost: string,
	interfaces: Readonly<Record<string, readonly LanInterfaceAddress[] | undefined>>,
	machineHostname: string,
): string {
	if (!isWildcardHost(bindHost)) return bindHost.replace(/^\[(.*)\]$/, "$1");
	return pickLanAddress(interfaces) ?? machineHostname;
}
