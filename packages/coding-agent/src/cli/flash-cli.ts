/**
 * Handles `omp flash <device>`: turn a USB stick into a bootable,
 * LUKS-encrypted, minimal Arch Linux system that carries the invoking user's
 * harness binary and credentials (issue #47).
 *
 * The flash is a linear orchestration of standard Arch tooling:
 * sgdisk → cryptsetup → pacstrap → genfstab → arch-chroot config →
 * grub-install (BIOS + UEFI) → rsync payload → symbolPreset override.
 *
 * Everything privileged runs through external commands; this module never
 * shells out through a string, only argv arrays. Pure planning helpers are
 * exported for tests.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { Settings } from "../config/settings";

// =============================================================================
// Types
// =============================================================================

export interface FlashCommandArgs {
	/** Whole-disk block device to obliterate, e.g. /dev/sdc */
	device: string;
	flags: {
		/** Also exclude agent/sessions and python-env for 8 GB-class sticks. */
		slim: boolean;
		/** Allow flashing a non-removable device. */
		force: boolean;
		/** Source harness binary; defaults to the running executable. */
		binary?: string;
		/** Payload owner; defaults to $SUDO_USER. */
		user?: string;
	};
}

interface DeviceInfo {
	path: string;
	type: string;
	removable: boolean;
	sizeBytes: number;
	model: string;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Everything pacstrap installs. Base system + boot chain + network + the P2V
 * and sysadmin toolkit from issue #47. Keep it a toolkit, not a distro.
 */
export const STICK_PACKAGES: readonly string[] = [
	// Base system + boot chain
	"base",
	"linux",
	"linux-firmware",
	"mkinitcpio",
	"grub",
	"efibootmgr",
	"sudo",
	// Network: wired DHCP, Wi-Fi, USB phone tethering — all through NetworkManager
	"networkmanager",
	// iPhone USB tethering: ipheth is in the kernel, but the trust/pairing
	// handshake needs the usbmuxd daemon. Android RNDIS/NCM needs nothing extra.
	"usbmuxd",
	"libimobiledevice",
	// Harness runtime: python for the eval kernel's recreatable env
	"python",
	// P2V toolkit
	"ddrescue",
	"ntfs-3g",
	"qemu-img",
	"partclone",
	"smartmontools",
	"nvme-cli",
	"hdparm",
	"pv",
	"rsync",
	"parted",
	"gptfdisk",
	"dosfstools",
	"e2fsprogs",
	// Sysadmin kit
	"openssh",
	"tmux",
	"git",
	"curl",
	"jq",
	"lsof",
	"usbutils",
	"pciutils",
	"ethtool",
	// Readable console on high-DPI panels (ter-132b); kbd's fonts come free
	// via systemd, terminus does not.
	"terminus-font",
];

/** Host tools the flash needs, mapped to the Arch package that owns them. */
export const REQUIRED_HOST_TOOLS: readonly [tool: string, pkg: string][] = [
	["lsblk", "util-linux"],
	["wipefs", "util-linux"],
	["sgdisk", "gptfdisk"],
	["partprobe", "parted"],
	["cryptsetup", "cryptsetup"],
	["mkfs.vfat", "dosfstools"],
	["mkfs.ext4", "e2fsprogs"],
	["blkid", "util-linux"],
	["pacstrap", "arch-install-scripts"],
	["genfstab", "arch-install-scripts"],
	["arch-chroot", "arch-install-scripts"],
	["rsync", "rsync"],
	["getent", "glibc"],
	["udevadm", "systemd"],
];

const MAPPER_NAME_PREFIX = "ompflash";
const STICK_HOSTNAME = "ompstick";

// =============================================================================
// Pure planning helpers (unit-tested)
// =============================================================================

/**
 * Partition device node for a whole-disk device. Devices whose name ends in a
 * digit (nvme0n1, loop0, mmcblk0) take a `p` separator; sdX-style do not.
 */
export function partitionPath(device: string, index: number): string {
	return /\d$/.test(device) ? `${device}p${index}` : `${device}${index}`;
}

/**
 * rsync argv for the `~/.omp` payload copy.
 *
 * Always excluded, at any depth: every `cache/` and `logs/` directory, plus
 * top-level `run/` — local ONNX model caches must not ship ("I'm not gonna run
 * a local model on that machine"). `--slim` additionally drops sessions and
 * the recreatable python env so the payload fits 8 GB-class sticks.
 */
export function buildOmpRsyncArgs(sourceOmp: string, destOmp: string, slim: boolean): string[] {
	const args = ["-aHX", "--numeric-ids", "--exclude=cache/", "--exclude=logs/", "--exclude=/run/"];
	if (slim) {
		args.push("--exclude=/agent/sessions/", "--exclude=/python-env/");
	}
	args.push(`${sourceOmp}/`, `${destOmp}/`);
	return args;
}

/**
 * Gate a candidate device: whole disks only, removable unless --force.
 * The typed-confirmation prompt is separate; this is the hard policy.
 */
export function assessDevice(info: DeviceInfo, force: boolean): { ok: true } | { ok: false; reason: string } {
	if (info.type !== "disk") {
		return { ok: false, reason: `${info.path} is a ${info.type}, not a whole disk` };
	}
	if (!info.removable && !force) {
		return {
			ok: false,
			reason: `${info.path} reports as non-removable; refusing without --force`,
		};
	}
	return { ok: true };
}

/**
 * Insert the `encrypt` hook before `filesystems` in /etc/mkinitcpio.conf so
 * the initramfs can open the LUKS root. Idempotent.
 */
export function rewriteMkinitcpioHooks(contents: string): string {
	return contents.replace(/^HOOKS=\((.*)\)$/m, (line, hooks: string) => {
		if (/\bencrypt\b/.test(hooks)) return line;
		if (!/\bfilesystems\b/.test(hooks)) return `HOOKS=(${hooks} encrypt)`;
		return `HOOKS=(${hooks.replace(/\bfilesystems\b/, "encrypt filesystems")})`;
	});
}

/**
 * Point the kernel at the LUKS container in /etc/default/grub. The mapper name
 * is fixed (`omproot`) — it is baked into the stick's fstab and cmdline.
 */
export function rewriteGrubDefaults(contents: string, luksUuid: string): string {
	const cmdline = `cryptdevice=UUID=${luksUuid}:omproot root=/dev/mapper/omproot rw`;
	if (/^GRUB_CMDLINE_LINUX=/m.test(contents)) {
		return contents.replace(/^GRUB_CMDLINE_LINUX=.*$/m, `GRUB_CMDLINE_LINUX="${cmdline}"`);
	}
	return `${contents}\nGRUB_CMDLINE_LINUX="${cmdline}"\n`;
}

/** Missing host tools as [tool, package] pairs; empty means ready. */
export function missingHostTools(which: (tool: string) => string | null): [string, string][] {
	return REQUIRED_HOST_TOOLS.filter(([tool]) => which(tool) === null);
}

// =============================================================================
// Prompt helpers
// =============================================================================

/**
 * Read one line from stdin, optionally without echo (passphrases). Uses a
 * plain `data` listener — async-iterating process.stdin destroys the stream
 * when the loop exits, which would break the second and third prompts.
 */
function promptLine(question: string, hidden: boolean): Promise<string> {
	process.stderr.write(question);
	const stdin = process.stdin;
	const interactive = stdin.isTTY === true;
	return new Promise((resolve, reject) => {
		let value = "";
		if (interactive) stdin.setRawMode(true);
		const finish = (error?: Error) => {
			stdin.removeListener("data", onData);
			if (interactive) stdin.setRawMode(false);
			stdin.pause();
			process.stderr.write("\n");
			if (error) reject(error);
			else resolve(value);
		};
		const onData = (chunk: Buffer) => {
			if (!interactive) {
				value += chunk.toString();
				const newline = value.indexOf("\n");
				if (newline !== -1) {
					value = value.slice(0, newline).replace(/\r$/, "");
					finish();
				}
				return;
			}
			for (const byte of chunk) {
				if (byte === 0x03) {
					finish(new FlashError("Interrupted"));
					return;
				}
				if (byte === 0x0d || byte === 0x0a) {
					finish();
					return;
				}
				if (byte === 0x7f || byte === 0x08) {
					if (value.length > 0) {
						value = value.slice(0, -1);
						if (!hidden) process.stderr.write("\b \b");
					}
					continue;
				}
				value += String.fromCharCode(byte);
				if (!hidden) process.stderr.write(String.fromCharCode(byte));
			}
		};
		stdin.on("data", onData);
		stdin.resume();
	});
}

// =============================================================================
// Process helpers
// =============================================================================

class FlashError extends Error {}

function logStep(title: string): void {
	process.stderr.write(`\n${chalk.cyan("==>")} ${chalk.bold(title)}\n`);
}

function logCommand(argv: readonly string[]): void {
	process.stderr.write(`${chalk.dim(`  $ ${argv.join(" ")}`)}\n`);
}

/** Run a command with inherited stdio; throw on nonzero exit. */
async function run(argv: readonly string[], options: { stdinData?: string } = {}): Promise<void> {
	logCommand(argv);
	const child = Bun.spawn([...argv], {
		stdin: options.stdinData === undefined ? "inherit" : "pipe",
		stdout: "inherit",
		stderr: "inherit",
	});
	if (options.stdinData !== undefined) {
		child.stdin?.write(options.stdinData);
		child.stdin?.end();
	}
	const code = await child.exited;
	if (code !== 0) throw new FlashError(`${argv[0]} exited with code ${code}`);
}

/** Run a command and capture trimmed stdout; throw on nonzero exit. */
async function capture(argv: readonly string[]): Promise<string> {
	const child = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "inherit" });
	const stdout = await new Response(child.stdout).text();
	const code = await child.exited;
	if (code !== 0) throw new FlashError(`${argv[0]} exited with code ${code}`);
	return stdout.trim();
}

/** Run a command, ignoring failure (teardown paths). */
async function runQuiet(argv: readonly string[]): Promise<void> {
	const child = Bun.spawn([...argv], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	await child.exited;
}

// =============================================================================
// Host introspection
// =============================================================================

async function inspectDevice(device: string): Promise<DeviceInfo> {
	const raw = await capture([
		"lsblk",
		"--json",
		"--bytes",
		"--nodeps",
		"--output",
		"NAME,TYPE,RM,SIZE,MODEL,PATH",
		device,
	]);
	const parsed = JSON.parse(raw) as {
		blockdevices?: {
			path?: string;
			name: string;
			type: string;
			rm: boolean | number;
			size: number;
			model?: string | null;
		}[];
	};
	const row = parsed.blockdevices?.[0];
	if (!row) throw new FlashError(`lsblk returned nothing for ${device}`);
	return {
		path: row.path ?? device,
		type: row.type,
		removable: row.rm === true || row.rm === 1,
		sizeBytes: row.size,
		model: row.model?.trim() || "(unknown model)",
	};
}

/** Resolve the payload owner: name, uid, gid, home. */
async function resolvePayloadUser(flagUser: string | undefined): Promise<{ name: string; home: string }> {
	const name = flagUser ?? process.env.SUDO_USER;
	if (!name || name === "root") {
		throw new FlashError(
			"Cannot determine the payload owner. Run via sudo from your own account, or pass --user <name>.",
		);
	}
	const entry = await capture(["getent", "passwd", name]);
	const fields = entry.split(":");
	const home = fields[5];
	if (!home) throw new FlashError(`No home directory in passwd entry for ${name}`);
	return { name, home };
}

/**
 * The harness binary that goes onto the stick. A compiled omomp copies itself
 * (exact version pinning, no fetch). Running from source under `bun src/cli.ts`
 * has no self-binary — require --binary then.
 */
export function resolveSourceBinary(execPath: string, flagBinary: string | undefined): string {
	if (flagBinary) return flagBinary;
	const base = path.basename(execPath);
	if (base === "bun" || base === "node") {
		throw new FlashError(
			"Running from source: there is no compiled harness binary to copy. Pass --binary <path-to-omomp>.",
		);
	}
	return execPath;
}

// =============================================================================
// Flash orchestration
// =============================================================================

interface Teardown {
	mounts: string[];
	mapper?: string;
	mountRoot?: string;
}

export async function runFlashCommand(cmd: FlashCommandArgs): Promise<number> {
	try {
		await flash(cmd);
		return 0;
	} catch (error) {
		if (error instanceof FlashError) {
			process.stderr.write(`${chalk.red("flash:")} ${error.message}\n`);
			return 1;
		}
		throw error;
	}
}

async function flash(cmd: FlashCommandArgs): Promise<void> {
	if (process.getuid?.() !== 0) {
		throw new FlashError(`flash partitions and formats a disk; run it with sudo: sudo omomp flash ${cmd.device}`);
	}

	const missing = missingHostTools(tool => Bun.which(tool));
	if (missing.length > 0) {
		const lines = missing.map(([tool, pkg]) => `  ${tool} (pacman -S ${pkg})`).join("\n");
		throw new FlashError(`Missing host tools:\n${lines}`);
	}

	const user = await resolvePayloadUser(cmd.flags.user);
	const sourceOmp = path.join(user.home, ".omp");
	const sourceSsh = path.join(user.home, ".ssh");
	const binary = resolveSourceBinary(process.execPath, cmd.flags.binary);
	await fs.access(sourceOmp).catch(() => {
		throw new FlashError(`${sourceOmp} does not exist; nothing to carry`);
	});
	await fs.access(binary).catch(() => {
		throw new FlashError(`Harness binary not found: ${binary}`);
	});

	// -- Device gate + typed confirmation ------------------------------------
	const device = await inspectDevice(cmd.device);
	const verdict = assessDevice(device, cmd.flags.force);
	if (!verdict.ok) throw new FlashError(verdict.reason);

	const sizeGib = (device.sizeBytes / 1024 ** 3).toFixed(1);
	process.stderr.write(
		`\n${chalk.red.bold("ALL DATA WILL BE DESTROYED")} on ${chalk.bold(device.path)}\n` +
			`  model: ${device.model}\n  size:  ${sizeGib} GiB\n  removable: ${device.removable ? "yes" : chalk.red("no (--force)")}\n\n`,
	);
	const typed = await promptLine(`Type the device path (${device.path}) to continue: `, false);
	if (typed.trim() !== device.path) {
		throw new FlashError(`Confirmation mismatch ("${typed.trim()}" != "${device.path}"); aborting`);
	}

	const passphrase = await promptLine("LUKS passphrase for the stick: ", true);
	if (passphrase.length === 0) throw new FlashError("Empty passphrase; aborting");
	const confirmed = await promptLine("Confirm passphrase: ", true);
	if (passphrase !== confirmed) throw new FlashError("Passphrases do not match; aborting");

	const teardown: Teardown = { mounts: [] };
	try {
		await flashDevice(cmd, device, user, binary, sourceOmp, sourceSsh, passphrase, teardown);
	} finally {
		await unwind(teardown);
	}

	process.stderr.write(
		`\n${chalk.green("Done.")} ${device.path} now boots your harness (BIOS + UEFI).\n` +
			`Passphrase at boot, auto-login as ${user.name}, then: omp\n`,
	);
}

async function flashDevice(
	cmd: FlashCommandArgs,
	device: DeviceInfo,
	user: { name: string; home: string },
	binary: string,
	sourceOmp: string,
	sourceSsh: string,
	passphrase: string,
	teardown: Teardown,
): Promise<void> {
	const esp = partitionPath(device.path, 2);
	const luks = partitionPath(device.path, 3);

	logStep("Partitioning (GPT: BIOS-boot + ESP /boot + LUKS root)");
	await run(["wipefs", "--all", device.path]);
	await run(["sgdisk", "--zap-all", device.path]);
	await run([
		"sgdisk",
		"--new=1:0:+1MiB",
		"--typecode=1:EF02",
		"--new=2:0:+1GiB",
		"--typecode=2:EF00",
		"--new=3:0:0",
		"--typecode=3:8309",
		device.path,
	]);
	await run(["partprobe", device.path]);
	await run(["udevadm", "settle"]);

	logStep("Creating LUKS2 container");
	// Cap the argon2id memory cost: cryptsetup benchmarks the *flashing* host,
	// and a workstation-sized cost can make the stick unopenable on the old,
	// small-RAM machines it exists for. 256 MiB unlocks anywhere.
	await run(
		[
			"cryptsetup",
			"luksFormat",
			"--type",
			"luks2",
			"--pbkdf",
			"argon2id",
			"--pbkdf-memory",
			"262144",
			"--batch-mode",
			"--key-file=-",
			luks,
		],
		{
			stdinData: passphrase,
		},
	);
	const mapper = `${MAPPER_NAME_PREFIX}-${process.pid.toString(36)}`;
	await run(["cryptsetup", "open", "--key-file=-", luks, mapper], { stdinData: passphrase });
	teardown.mapper = mapper;
	const root = `/dev/mapper/${mapper}`;

	logStep("Creating filesystems");
	await run(["mkfs.vfat", "-F", "32", "-n", "OMPBOOT", esp]);
	await run(["mkfs.ext4", "-q", "-L", "omproot", root]);

	logStep("Mounting");
	const mnt = await fs.mkdtemp("/tmp/omomp-flash-");
	teardown.mountRoot = mnt;
	await run(["mount", root, mnt]);
	teardown.mounts.push(mnt);
	await fs.mkdir(path.join(mnt, "boot"));
	await run(["mount", esp, path.join(mnt, "boot")]);
	teardown.mounts.push(path.join(mnt, "boot"));

	logStep("Installing base system (pacstrap; this downloads packages)");
	await run(["pacstrap", "-c", "-K", mnt, ...STICK_PACKAGES]);

	logStep("Writing fstab");
	const fstab = await capture(["genfstab", "-U", mnt]);
	await fs.appendFile(path.join(mnt, "etc/fstab"), fstab);

	logStep("Configuring system");
	await fs.writeFile(path.join(mnt, "etc/hostname"), `${STICK_HOSTNAME}\n`);
	await fs.writeFile(path.join(mnt, "etc/vconsole.conf"), "KEYMAP=us\n");
	await fs.appendFile(path.join(mnt, "etc/locale.gen"), "en_US.UTF-8 UTF-8\n");
	await fs.writeFile(path.join(mnt, "etc/locale.conf"), "LANG=en_US.UTF-8\n");
	await run(["arch-chroot", mnt, "locale-gen"]);
	await fs.rm(path.join(mnt, "etc/localtime"), { force: true });
	await fs.symlink("/usr/share/zoneinfo/UTC", path.join(mnt, "etc/localtime"));

	const mkinitcpioPath = path.join(mnt, "etc/mkinitcpio.conf");
	await fs.writeFile(mkinitcpioPath, rewriteMkinitcpioHooks(await fs.readFile(mkinitcpioPath, "utf8")));
	await run(["arch-chroot", mnt, "mkinitcpio", "-P"]);

	logStep("Installing GRUB (BIOS + UEFI)");
	const luksUuid = await capture(["blkid", "--match-tag", "UUID", "--output", "value", luks]);
	const grubDefaultsPath = path.join(mnt, "etc/default/grub");
	await fs.writeFile(grubDefaultsPath, rewriteGrubDefaults(await fs.readFile(grubDefaultsPath, "utf8"), luksUuid));
	await run(["arch-chroot", mnt, "grub-install", "--target=i386-pc", device.path]);
	await run([
		"arch-chroot",
		mnt,
		"grub-install",
		"--target=x86_64-efi",
		"--efi-directory=/boot",
		"--removable",
		"--no-nvram",
	]);
	await run(["arch-chroot", mnt, "grub-mkconfig", "-o", "/boot/grub/grub.cfg"]);

	logStep(`Creating user ${user.name} (autologin tty1, passwordless sudo)`);
	await run(["arch-chroot", mnt, "useradd", "--create-home", "--groups", "wheel", "--shell", "/bin/bash", user.name]);
	const sudoersPath = path.join(mnt, "etc/sudoers.d/10-ompflash");
	await fs.writeFile(sudoersPath, `${user.name} ALL=(ALL:ALL) NOPASSWD: ALL\n`, { mode: 0o440 });
	const gettyDir = path.join(mnt, "etc/systemd/system/getty@tty1.service.d");
	await fs.mkdir(gettyDir, { recursive: true });
	await fs.writeFile(
		path.join(gettyDir, "autologin.conf"),
		`[Service]\nExecStart=\nExecStart=-/sbin/agetty --autologin ${user.name} --noclear %I $TERM\n`,
	);
	await run(["arch-chroot", mnt, "systemctl", "enable", "NetworkManager", "systemd-timesyncd"]);

	logStep("Installing harness binary");
	const binDest = path.join(mnt, "usr/local/bin/omomp");
	await fs.copyFile(binary, binDest);
	await fs.chmod(binDest, 0o755);
	await fs.symlink("omomp", path.join(mnt, "usr/local/bin/omp"));

	logStep(cmd.flags.slim ? "Copying ~/.omp payload (--slim)" : "Copying ~/.omp payload");
	const homeDest = path.join(mnt, "home", user.name);
	const ompDest = path.join(homeDest, ".omp");
	await fs.mkdir(ompDest, { recursive: true });
	await run(["rsync", ...buildOmpRsyncArgs(sourceOmp, ompDest, cmd.flags.slim)]);

	const sshExists = await fs.access(sourceSsh).then(
		() => true,
		() => false,
	);
	if (sshExists) {
		logStep("Copying ~/.ssh");
		await run(["rsync", "-a", `${sourceSsh}/`, `${path.join(homeDest, ".ssh")}/`]);
		await fs.chmod(path.join(homeDest, ".ssh"), 0o700);
	}

	logStep("Forcing ASCII symbol preset (console has no nerd fonts)");
	const stickSettings = await Settings.loadIsolated({ agentDir: path.join(ompDest, "agent") });
	stickSettings.set("symbolPreset", "ascii");
	await stickSettings.flush();

	await run(["arch-chroot", mnt, "chown", "-R", `${user.name}:${user.name}`, `/home/${user.name}`]);
}

async function unwind(teardown: Teardown): Promise<void> {
	for (const mount of [...teardown.mounts].reverse()) {
		await runQuiet(["umount", "-R", mount]);
	}
	if (teardown.mapper) await runQuiet(["cryptsetup", "close", teardown.mapper]);
	if (teardown.mountRoot) await fs.rm(teardown.mountRoot, { recursive: true, force: true }).catch(() => {});
	spawnSync("sync");
}
