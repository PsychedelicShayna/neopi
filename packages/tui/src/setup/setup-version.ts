/**
 * Setup version the wizard advances a fresh install to. Bump it whenever a new
 * setup scene lands (or an existing scene raises its `minVersion`).
 *
 * Kept in its own dependency-free module so the cold-launch gate in `main.ts`
 * can answer "is the stored setup version stale?" without statically importing
 * the full wizard — every scene (sign-in/OAuth, web search, theme previews) plus
 * the overlay component and their TUI deps. Must be at least the highest scene
 * `minVersion`; keep it monotonic when removing scenes. Version 3 was the
 * removed upstream omp auto-update question.
 */
export const CURRENT_SETUP_VERSION = 3;
