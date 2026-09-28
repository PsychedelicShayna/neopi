/**
 * Minimal stdio MCP server for tests. Touches the marker file given as the
 * second argument on startup, then serves one `ping` tool.
 * Usage: bun mcp-marker-server.ts <server-name> <marker-path>
 */
const [serverName = "marker", markerPath] = process.argv.slice(2);
if (markerPath) await Bun.write(markerPath, "");

function reply(id: number | string, result: unknown): void {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
	buffer += new TextDecoder().decode(chunk);
	let newline = buffer.indexOf("\n");
	while (newline !== -1) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		newline = buffer.indexOf("\n");
		if (!line) continue;
		const message = JSON.parse(line) as {
			id?: number | string;
			method?: string;
			params?: { protocolVersion?: string };
		};
		if (message.id === undefined) continue;
		if (message.method === "initialize") {
			reply(message.id, {
				protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: serverName, version: "0" },
			});
		} else if (message.method === "tools/list") {
			reply(message.id, {
				tools: [{ name: "ping", description: "ping", inputSchema: { type: "object", properties: {} } }],
			});
		} else {
			reply(message.id, {});
		}
	}
}
