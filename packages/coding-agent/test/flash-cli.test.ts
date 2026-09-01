import { describe, expect, test } from "bun:test";
import {
	assessDevice,
	buildOmpRsyncArgs,
	forceAsciiSymbolPreset,
	missingHostTools,
	partitionPath,
	resolveSourceBinary,
	rewriteGrubDefaults,
	rewriteMkinitcpioHooks,
	STICK_PACKAGES,
} from "../src/cli/flash-cli";

describe("partitionPath", () => {
	test("sdX-style devices concatenate the index", () => {
		expect(partitionPath("/dev/sdc", 3)).toBe("/dev/sdc3");
	});

	test("devices ending in a digit take a p separator", () => {
		expect(partitionPath("/dev/nvme0n1", 2)).toBe("/dev/nvme0n1p2");
		expect(partitionPath("/dev/loop0", 1)).toBe("/dev/loop0p1");
		expect(partitionPath("/dev/mmcblk0", 3)).toBe("/dev/mmcblk0p3");
	});
});

describe("buildOmpRsyncArgs", () => {
	test("default excludes any-depth cache/logs and top-level run, keeps sessions", () => {
		const args = buildOmpRsyncArgs("/home/u/.omp", "/mnt/home/u/.omp", false);
		expect(args).toContain("--exclude=cache/");
		expect(args).toContain("--exclude=logs/");
		expect(args).toContain("--exclude=/run/");
		expect(args).not.toContain("--exclude=/agent/sessions/");
		expect(args).not.toContain("--exclude=/python-env/");
	});

	test("--slim additionally drops sessions and the python env", () => {
		const args = buildOmpRsyncArgs("/home/u/.omp", "/mnt/home/u/.omp", true);
		expect(args).toContain("--exclude=/agent/sessions/");
		expect(args).toContain("--exclude=/python-env/");
	});

	test("source and destination carry trailing slashes for content copy", () => {
		const args = buildOmpRsyncArgs("/home/u/.omp", "/mnt/home/u/.omp", false);
		expect(args.at(-2)).toBe("/home/u/.omp/");
		expect(args.at(-1)).toBe("/mnt/home/u/.omp/");
	});
});

describe("assessDevice", () => {
	const disk = { path: "/dev/sdc", type: "disk", removable: true, sizeBytes: 16e9, model: "USB Stick" };

	test("accepts a removable whole disk", () => {
		expect(assessDevice(disk, false)).toEqual({ ok: true });
	});

	test("rejects partitions outright", () => {
		const verdict = assessDevice({ ...disk, path: "/dev/sdc1", type: "part" }, true);
		expect(verdict.ok).toBe(false);
	});

	test("rejects non-removable devices without --force, allows with it", () => {
		const fixed = { ...disk, removable: false };
		expect(assessDevice(fixed, false).ok).toBe(false);
		expect(assessDevice(fixed, true)).toEqual({ ok: true });
	});
});

describe("rewriteMkinitcpioHooks", () => {
	const stock =
		"MODULES=()\nHOOKS=(base udev autodetect microcode modconf kms keyboard keymap consolefont block filesystems fsck)\n";

	test("inserts encrypt before filesystems", () => {
		expect(rewriteMkinitcpioHooks(stock)).toContain("block encrypt filesystems fsck");
	});

	test("is idempotent", () => {
		const once = rewriteMkinitcpioHooks(stock);
		expect(rewriteMkinitcpioHooks(once)).toBe(once);
	});

	test("appends encrypt when filesystems is absent", () => {
		expect(rewriteMkinitcpioHooks("HOOKS=(base udev block)\n")).toContain("HOOKS=(base udev block encrypt)");
	});
});

describe("rewriteGrubDefaults", () => {
	test("replaces an existing GRUB_CMDLINE_LINUX", () => {
		const out = rewriteGrubDefaults('GRUB_TIMEOUT=5\nGRUB_CMDLINE_LINUX=""\n', "abcd-1234");
		expect(out).toContain('GRUB_CMDLINE_LINUX="cryptdevice=UUID=abcd-1234:omproot root=/dev/mapper/omproot rw"');
		expect(out.match(/^GRUB_CMDLINE_LINUX=/gm)).toHaveLength(1);
	});

	test("appends when the key is missing", () => {
		const out = rewriteGrubDefaults("GRUB_TIMEOUT=5\n", "abcd-1234");
		expect(out).toContain("cryptdevice=UUID=abcd-1234:omproot");
	});
});

describe("missingHostTools", () => {
	test("reports only tools which cannot be resolved", () => {
		const missing = missingHostTools(tool => (tool === "pacstrap" || tool === "sgdisk" ? null : "/usr/bin/x"));
		expect(missing.map(([tool]) => tool).sort()).toEqual(["pacstrap", "sgdisk"]);
	});
});

describe("resolveSourceBinary", () => {
	test("an explicit --binary always wins", () => {
		expect(resolveSourceBinary("/usr/bin/bun", "/home/u/.local/bin/omomp")).toBe("/home/u/.local/bin/omomp");
	});

	test("a compiled executable copies itself", () => {
		expect(resolveSourceBinary("/home/u/.local/bin/omomp", undefined)).toBe("/home/u/.local/bin/omomp");
	});

	test("running from source without --binary is an error", () => {
		expect(() => resolveSourceBinary("/usr/bin/bun", undefined)).toThrow(/--binary/);
	});
});

describe("STICK_PACKAGES", () => {
	test("carries the issue #47 P2V toolkit", () => {
		for (const pkg of ["ddrescue", "ntfs-3g", "qemu-img", "partclone", "smartmontools"]) {
			expect(STICK_PACKAGES).toContain(pkg);
		}
	});

	test("carries the boot chain for BIOS+UEFI hybrid", () => {
		for (const pkg of ["grub", "efibootmgr", "mkinitcpio", "linux-firmware", "networkmanager"]) {
			expect(STICK_PACKAGES).toContain(pkg);
		}
	});
});

describe("forceAsciiSymbolPreset", () => {
	test("replaces an existing top-level key without touching neighbors", () => {
		const out = forceAsciiSymbolPreset("setupVersion: 2\nsymbolPreset: nerd\ndarkTheme: catppuccin\n");
		expect(out).toBe("setupVersion: 2\nsymbolPreset: ascii\ndarkTheme: catppuccin\n");
	});

	test("appends when the key is absent", () => {
		expect(forceAsciiSymbolPreset("setupVersion: 2\n")).toBe("setupVersion: 2\nsymbolPreset: ascii\n");
	});

	test("handles an empty or missing config", () => {
		expect(forceAsciiSymbolPreset("")).toBe("symbolPreset: ascii\n");
	});

	test("adds a newline before appending to an unterminated file", () => {
		expect(forceAsciiSymbolPreset("setupVersion: 2")).toBe("setupVersion: 2\nsymbolPreset: ascii\n");
	});
});
