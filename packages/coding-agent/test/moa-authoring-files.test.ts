import { expect, spyOn, test } from "bun:test";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	ABSENT,
	digest,
	readHash,
	readSource,
	SourceConflictError,
	writeSource,
	type MixtureSource,
} from "@oh-my-pi/pi-coding-agent/moa/authoring-files";

// Simulate the Windows failures on Linux without weakening the POSIX contract.
for (const platform of ["win32", "linux"] as const) {
	for (const code of ["EPERM", "EISDIR"] as const) {
		test(`${platform} mixture saves ${platform === "win32" ? "skip" : "propagate"} directory ${code}`, async () => {
			const dir = await fs.mkdtemp(path.join(tmpdir(), "deck-mixture-fsync-"));
			const file = path.join(dir, "MIXTURES.toml");
			const source: MixtureSource = {
				id: "test",
				path: file,
				kind: "project",
				order: 0,
				expectedDir: await fs.realpath(dir),
			};
			const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
			const open = fs.open;
			let fileSyncs = 0;
			let directoryOpens = 0;
			const syncSpies: Array<{ mockRestore(): void }> = [];
			const failure = Object.assign(new Error(`${code}: directory fsync unsupported`), { code });
			const openSpy = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
				if (args[0] === dir) {
					directoryOpens++;
					expect(args[1]).toBe(constants.O_RDONLY | constants.O_DIRECTORY);
					if (code === "EISDIR") throw failure;
					// A regular-file handle keeps the simulated sync failure portable.
					const handle = await open(file, "r");
					syncSpies.push(spyOn(handle, "sync").mockRejectedValue(failure));
					return handle;
				}
				const handle = await open(...args);
				if (String(args[0]).endsWith(".tmp")) {
					const sync = handle.sync.bind(handle);
					syncSpies.push(
						spyOn(handle, "sync").mockImplementation(async () => {
							fileSyncs++;
							await sync();
						}),
					);
				}
				return handle;
			});
			try {
				Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
				const first = '[[mixtures]]\nname = "first"\n';
				if (platform === "linux") {
					await expect(writeSource(source, first, ABSENT, 4096)).rejects.toBe(failure);
					expect(directoryOpens).toBe(1);
					expect(fileSyncs).toBe(1);
					return;
				}
				await writeSource(source, first, ABSENT, 4096);
				expect(await readSource(file, 4096)).toMatchObject({ state: "file", text: first });
				expect(readHash(await readSource(file, 4096))).toBe(digest(first));
				await expect(writeSource(source, "stale", ABSENT, 4096)).rejects.toBeInstanceOf(SourceConflictError);
				expect(await fs.readFile(file, "utf8")).toBe(first);
				const second = '[[mixtures]]\nname = "second"\n';
				await writeSource(source, second, digest(first), 4096);
				expect(await fs.readFile(file, "utf8")).toBe(second);
				await writeSource(source, null, digest(second), 4096);
				expect(await readSource(file, 4096)).toEqual({ state: "absent" });
				expect(await fs.readdir(dir)).toEqual([]);
				expect(fileSyncs).toBe(2);
				expect(directoryOpens).toBe(0);
			} finally {
				Object.defineProperty(process, "platform", platformDescriptor);
				openSpy.mockRestore();
				for (const spy of syncSpies) spy.mockRestore();
				await fs.rm(dir, { recursive: true, force: true });
			}
		});
	}
}
