export interface IrcRoomPermissions {
	receive: boolean;
	send: boolean;
	invite: boolean;
	admin: boolean;
}

export interface IrcRoomMute {
	by: string;
	authority: "self" | "admin" | "operator";
	until?: number;
}

export type IrcRoomJoinMode = "silent" | "announce" | "invisible";
export type IrcInviteNoticeMode = "next-turn" | "wake-now" | "verbose" | "silent";

/** Retain policy even if the peer leaves; open re-joining must not bypass it. */
export interface IrcMemberPolicy {
	permissions?: IrcRoomPermissions;
	mute?: IrcRoomMute;
	joinMode?: IrcRoomJoinMode;
}

export const DEFAULT_PERMISSIONS: Readonly<IrcRoomPermissions> = Object.freeze({
	receive: true,
	send: true,
	invite: true,
	admin: false,
});
const ADMIN_PERMISSIONS: Readonly<IrcRoomPermissions> = Object.freeze({ ...DEFAULT_PERMISSIONS, admin: true });
const NO_PERMISSIONS: Readonly<IrcRoomPermissions> = Object.freeze({
	receive: false,
	send: false,
	invite: false,
	admin: false,
});
const PERMISSION_KEYS = ["receive", "send", "invite", "admin"] as const;

export function effectivePermissions(
	policy: IrcMemberPolicy | undefined,
	member: boolean,
	intrinsicAdmin: boolean,
): Readonly<IrcRoomPermissions> {
	if (intrinsicAdmin || (member && policy?.permissions?.admin)) return ADMIN_PERMISSIONS;
	return member ? (policy?.permissions ?? DEFAULT_PERMISSIONS) : NO_PERMISSIONS;
}

export function patchPermissions(
	base: Readonly<IrcRoomPermissions>,
	patch?: Partial<IrcRoomPermissions>,
): IrcRoomPermissions {
	return {
		receive: patch?.receive ?? base.receive,
		send: patch?.send ?? base.send,
		invite: patch?.invite ?? base.invite,
		admin: patch?.admin ?? base.admin,
	};
}

export function missingGrant(
	ceiling: Readonly<IrcRoomPermissions>,
	grant: Readonly<Partial<IrcRoomPermissions>>,
): keyof IrcRoomPermissions | undefined {
	if (grant.admin && !ceiling.admin) return "admin";
	return PERMISSION_KEYS.find(key => grant[key] && !ceiling[key]);
}

export function samePermissions(a: Readonly<IrcRoomPermissions>, b: Readonly<IrcRoomPermissions>): boolean {
	return PERMISSION_KEYS.every(key => a[key] === b[key]);
}

export function activeMute(policy?: IrcMemberPolicy, now = Date.now()): IrcRoomMute | undefined {
	const mute = policy?.mute;
	return mute && (mute.until === undefined || mute.until > now) ? mute : undefined;
}

export function mayLiftMute(mute: IrcRoomMute, actor: string, admin: boolean, operator: boolean): boolean {
	return operator || (mute.authority !== "operator" && (admin || (mute.authority === "self" && mute.by === actor)));
}

export function muteDeadline(duration: string | undefined, now = Date.now()): number | undefined {
	if (duration === undefined) return undefined;
	const match = /^(\d+)([mh])$/iu.exec(duration.trim());
	if (!match) return NaN;
	const until = now + Number(match[1]) * (match[2]!.toLowerCase() === "h" ? 3_600_000 : 60_000);
	return Number.isSafeInteger(until) && until > now ? until : NaN;
}
