/**
 * Parent pid recorded when this module is first evaluated.
 *
 * The CLI entry imports this before its startup work, so the value names the
 * process that launched NeoPi even if that process dies while startup is still
 * loading modules: after the parent dies the kernel reparents this process and
 * `process.ppid` names the reaper instead.
 */
export const LAUNCH_PARENT_PID = process.ppid;
