import { acquireFileLock } from "../../src/file-lock";

const target = Bun.argv[2];
const readyPath = Bun.argv[3];
if (!target || !readyPath) throw new Error("cooperative-file-lock-holder requires target and readiness paths");
const owner = await acquireFileLock(target, { retries: 1, takeoverStoppedOwner: true });
await Bun.write(readyPath, "ready");
await Bun.stdin.text();
const owned = owner.isOwner?.();
owner.release();
await Bun.write(`${readyPath}.released`, JSON.stringify({ owned }));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
