import { expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getSessionsDir, setAgentDir, setProfile } from "@oh-my-pi/pi-utils/dirs";

test("rejects named profiles that escape temporary test storage", () => {
	delete process.env.PI_CONFIG_DIR;
	setProfile("work");

	expect(() => getAgentDir()).toThrow("outside its isolated temporary storage");
	expect(() => getSessionsDir()).toThrow("outside its isolated temporary storage");
});

test("rejects agent and session directories outside temporary test storage", () => {
	setAgentDir(path.join(os.homedir(), ".omp", "agent"));

	expect(() => getAgentDir()).toThrow("outside its isolated temporary storage");
	expect(() => getSessionsDir()).toThrow("outside its isolated temporary storage");
});
