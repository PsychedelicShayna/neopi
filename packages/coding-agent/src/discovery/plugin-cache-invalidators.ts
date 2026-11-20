/** Kept import-free so plugins can register while the discovery graph is still evaluating. */
const pluginCacheInvalidators = new Set<() => void>();

/** Register a process-global cache invalidator called whenever plugin roots are cleared. */
export function registerPluginCacheInvalidator(invalidator: () => void): void {
	pluginCacheInvalidators.add(invalidator);
}

/** Clear dependent plugin caches without changing their registration lifetime. */
export function invalidateDependentPluginCaches(): void {
	for (const invalidate of pluginCacheInvalidators) invalidate();
}
