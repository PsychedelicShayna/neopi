import { BlockList, isIP } from "node:net";
import { SwitchError } from "./error";

export function normalizeAddress(input: string): string | undefined {
	const bracketed = input.startsWith("[") && input.endsWith("]") ? input.slice(1, -1) : input;
	const raw = bracketed.split("%", 1)[0];
	const family = isIP(raw);
	if (family === 4) return raw;
	if (family !== 6) return undefined;
	let address: string;
	try {
		address = new URL(`http://[${raw}]/`).hostname.slice(1, -1);
	} catch {
		return undefined;
	}
	const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(address);
	if (!mapped) return address;
	const high = Number.parseInt(mapped[1], 16),
		low = Number.parseInt(mapped[2], 16);
	return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

export function isLoopbackHost(host: string): boolean {
	if (host.toLowerCase() === "localhost") return true;
	const address = normalizeAddress(host);
	return address === "::1" || (address !== undefined && isIP(address) === 4 && address.startsWith("127."));
}

export function compileCidrs(cidrs: readonly string[]): BlockList {
	const result = new BlockList();
	for (const cidr of cidrs) {
		const [address, prefix] = cidr.split("/");
		result.addSubnet(address, Number(prefix), isIP(address) === 4 ? "ipv4" : "ipv6");
	}
	return result;
}

export function allowsAddress(policy: BlockList, address: string): boolean {
	const normalized = normalizeAddress(address);
	return normalized !== undefined && policy.check(normalized, isIP(normalized) === 4 ? "ipv4" : "ipv6");
}

/** Only a trusted accepted socket peer may supply the proxy-appended last hop. */
export function resolveSwitchPeer(
	socketAddress: string | undefined,
	forwarded: string | null,
	trustedProxies: BlockList,
): string {
	const socket = socketAddress === undefined ? undefined : normalizeAddress(socketAddress);
	if (!socket) throw new SwitchError(403, "peer_unknown", "The accepted socket peer is unavailable");
	if (!forwarded || !allowsAddress(trustedProxies, socket)) return socket;
	const peer = normalizeAddress(forwarded.split(",").at(-1)!.trim());
	if (!peer) throw new SwitchError(400, "invalid_forwarded_peer", "A trusted proxy must append a valid IP address");
	return peer;
}

export function isExactOrigin(value: string): boolean {
	if (!/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+$/i.test(value)) return false;
	try {
		const url = new URL(value);
		return !!url.hostname && !url.username && !url.password;
	} catch {
		return false;
	}
}
