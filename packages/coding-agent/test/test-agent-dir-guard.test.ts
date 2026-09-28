import { expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getSessionsDir, setAgentDir, setProfile } from "@oh-my-pi/pi-utils/dirs";

test("named profiles remain inside temporary test storage", () => {
	setProfile("work");

	expect(path.resolve(getAgentDir()).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)).toBe(true);
	expect(path.resolve(getSessionsDir()).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)).toBe(true);
});

test("rejects agent and session directories outside temporary test storage", () => {
	setAgentDir(path.join(os.homedir(), ".omp", "agent"));

	expect(() => getAgentDir()).toThrow("outside its isolated temporary storage");
	expect(() => getSessionsDir()).toThrow("outside its isolated temporary storage");
});
