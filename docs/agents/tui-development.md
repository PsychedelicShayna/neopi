# NeoPi terminal interfaces

## Menu Navigation

Vim navigation is opt-in through `tui.vimMode` (default `false`), which also enables modal prompt and search editing. With it disabled, retain ordinary navigation and literal text editing; do not consume Vim-only motions or advertise them in hints. Read the live preference through `getMenuSearchVimMode()` in `packages/tui/src/components/menu-navigation.ts`, including in direct handlers and native adapters.

Open menus, pickers, overlays and lists in navigation unless explicitly search-first. Use `MenuKeyReader` and `MenuViewport`; `SelectList` is the reference consumer. The Vim motions below apply only with Vim mode enabled. Ordinary arrows, PageUp/PageDown, Enter, Esc, search focus, context switching and surface actions remain available independently.

| Keys | Meaning in normal navigation |
| --- | --- |
| `j`/`k` | Next/previous row. |
| `h`/`l` | Context-dependent: switch pane, collapse/expand, reorder, or adjust a value (effort). Pick one meaning per surface and show it in the hint line. |
| `Ctrl-d`/`Ctrl-u` | Half page down/up. PageDown/PageUp: full page. |
| `gg`/`G` | First/last row. |
| `Ctrl-e`/`Ctrl-y` | Scroll the view one line; the selection stays where it is. |
| `Space` | Toggle a checkbox, or soft-activate (preview without closing). |
| `Tab`/`Shift-Tab` | Next/previous context: tab, section, or focus region. |
| `/` | Focus the surface's filter or search field. |
| `Ctrl-o`/`Ctrl-i` | Back/forward through the menu history (`Alt-o` is the forward fallback where the terminal sends Tab for `Ctrl-i`). |

Text input is the exception. Focused fields keep printable keys and editing bindings literal. Search/filter fields use `MenuSearchField`: Enter confirms and retains the pattern without activating a result; Esc clears it and returns to navigation. Navigation keys MUST stay in the field while editing. `/` refocuses the active pattern. Ordinary patterns remain fuzzy; `/`-prefixed and `re:` patterns share the Vim translator in `menu-search.ts`, very-magic by default (`\m` selects default-magic), including inline errors and no matches for invalid regex. See [Menu search](../keybindings.md#menu-search) for the dialect. Rename/form fields retain their own submit/cancel contracts; the composer is out of scope.

Before binding a single printable key on a menu surface, check the table: a surface action that collides with a navigation key moves to another key rather than shadowing navigation. Leave a key unbound where its meaning would be nonsensical for that surface instead of forcing parity, and record the decision in the issue's menu inventory. Opening a single-instance menu goes through `SelectorController`'s menu registry so the menu history can return to it with its state.

## TUI Sanitization

All text displayed in tool renderers must be sanitized. Raw content (file contents, error messages, tool output) breaks terminal rendering: tabs → visual holes, long lines → overflow, paths → leak home directory.

**Rules:**

- **Tabs → spaces** via `replaceTabs()` (from `@oh-my-pi/pi-tui` or `../tools/render-utils`).
- **Truncate** lines with `truncateToWidth()` / `ui.truncate()`. Use `TRUNCATE_LENGTHS` constants.
- **Shorten paths** with `shortenPath()` (replaces home with `~`).
- **Preview limits** from `PREVIEW_LIMITS`. No ad-hoc numbers.

**Apply to every render path**, not just the happy one:

- Success output (file previews, command output, search results).
- **Error messages** — these often embed file content (e.g., patch failure messages include unmatched lines). If a message contains file content, it needs `replaceTabs()`.
- Diff content (added and removed).
- Streaming previews.

### Streaming tool previews

Tool-call previews can have **multiple render paths**. If you add preview-only fields or depend on partially streamed args, update every path — not only the final renderer. Streamed argument buffers decode into display args via `decodeStreamedToolArgs` / `ToolArgsRevealController` (`modes/controllers/tool-args-reveal.ts`); both the live event path and transcript rebuilds must go through them — never spread provider-parsed `arguments` next to a raw `__partialJson` (parsed args lag the stream by a throttled parse window).

For the bash tool specifically:

- The pending preview may need raw `partialJson`, not just parsed `arguments`. Parsed args lag until a JSON object closes, which makes inline env assignments appear only at the end.
- Preserve preview-only fields (e.g. `__partialJson`) through `event-controller.ts`, transcript rebuilds in `ui-helpers.ts`, and merged call/result rendering in `tool-execution.ts`. Missing one path causes inconsistent previews.
- `ToolExecutionComponent.#buildRenderContext()` for bash must work even before a result exists — the renderer uses call args plus render context to show the command preview while streaming.
- Verify both live streaming and rebuilt transcript paths after any bash preview change. A fix in one path does not fix the other.
