# Keybindings

Run `/hotkeys` inside an `omp` session for the built-in shortcut reference. Application-action rows reflect remaps loaded from disk; navigation/editing examples use fixed chords. This is not an inventory of extension-registered shortcuts.

Base editor, input, and selector actions use `tui.editor.*`, `tui.input.*`, and `tui.select.*`; application actions use `app.*`. Definitions live in `packages/tui/src/keybindings.ts` and `packages/tui/src/app-keybindings.ts`.

## Customize keybindings

User remaps live in `~/.omp/agent/keybindings.yml`. The file is a YAML mapping whose keys are keybinding action IDs and whose values are either one chord string or an array of chord strings. It is not read from `~/.omp/agent/config.yml`, and there is no nested `keybindings` object.

With a named profile, bindings from the default profile's agent directory are loaded first and the active profile's `keybindings.yml` overrides them action by action. The inherited file is read-only during that profile's startup.

```yaml
app.model.cycleForward: Ctrl+P
app.model.selectTemporary: Alt+P
app.plan.toggle: Alt+Shift+P
```

Chord names are case-insensitive and use the same notation shown in the UI, such as `Ctrl+P`, `Alt+Shift+P`, `Shift+Enter`, and `Ctrl+Backspace`.

Set an action to an empty array to disable it:

```yaml
app.history.search: []
```

## Common action IDs

| Action ID                    | Default                                                               | Meaning                                                                                                                                                                              |
| ---------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app.model.cycleForward`     | `Ctrl+P`                                                              | Cycle role models forward                                                                                                                                                            |
| `app.model.cycleBackward`    | `Shift+Ctrl+P`                                                        | Cycle role models backward                                                                                                                                                           |
| `app.model.selectTemporary`  | `Alt+P`                                                               | Pick a model temporarily for this session                                                                                                                                            |
| `app.model.select`           | `Alt+M`                                                               | Open the model selector and set roles                                                                                                                                                |
| `app.plan.toggle`            | `Alt+Shift+P`                                                         | Toggle plan mode                                                                                                                                                                     |
| `app.history.search`         | `Ctrl+R`                                                              | Search prompt history                                                                                                                                                                |
| `app.navigation.back`        | `Ctrl+O`                                                              | Return to the previously visited menu (with its state) or the conversation; see [Menu navigation](#menu-navigation)                                                                 |
| `app.navigation.forward`     | `Ctrl+I`, `Alt+O`                                                     | Go forward in the menu history. `Ctrl+I` arrives distinct from `Tab` only under the Kitty keyboard protocol or xterm modifyOtherKeys; `Alt+O` works everywhere                       |
| `app.tools.expand`           | `Alt+E`                                                               | Toggle tool-output expansion                                                                                                                                                         |
| `app.tools.toggleVisibility` | `Ctrl+Shift+O`                                                        | Show or hide tool activity                                                                                                                                                           |
| `app.ask.hide`               | `Alt+H`                                                               | Hide a pending `ask` question to one line (the Hide button in Tern); the same key, `Enter`, or Show brings it back                                                                   |
| `app.thinking.toggle`        | `Ctrl+T`                                                              | Toggle thinking-block visibility                                                                                                                                                     |
| `app.thinking.cycle`         | `Shift+Tab`                                                           | Cycle thinking level                                                                                                                                                                 |
| `app.editor.external`        | `Ctrl+G`                                                              | Edit the draft in `$VISUAL` / `$EDITOR`                                                                                                                                              |
| `app.message.followUp`       | `Ctrl+Q`, `Ctrl+Enter`                                                | Queue a follow-up message                                                                                                                                                            |
| `app.message.chain`          | `Alt+C`                                                               | Send the composer text through the active post-processing chain (see `/chain`); asks which chain when none is active                                                               |
| `app.repl.toggle`            | `Alt+Shift+R`                                                         | Toggle REPL mode between the agent and the last kernel (see `/repl`)                                                                                                                 |
| `app.repl.execute`           | `Ctrl+Q`, `Ctrl+Enter`                                                | In REPL mode, run the composer in the selected kernel; outside REPL mode these chords stay follow-up                                                                                 |
| `app.message.dequeue`        | `Alt+Up`, `Shift+Up`                                                  | Dequeue a queued message back into the editor                                                                                                                                        |
| `app.retry`                  | `F5`, `Alt+R`                                                         | Retry the last failed assistant turn                                                                                                                                                 |
| `app.display.reset`          | `Alt+L`                                                               | Reset terminal display                                                                                                                                                               |
| `app.clipboard.copyLine`     | `Alt+Shift+L`                                                         | Copy the current line                                                                                                                                                                |
| `app.clipboard.copyPrompt`   | `Alt+Shift+C`                                                         | Copy the whole prompt                                                                                                                                                                |
| `app.clipboard.pasteTextRaw` | `Ctrl+Shift+V`, `Alt+Shift+V`                                         | Paste clipboard text without collapsing it                                                                                                                                           |
| `app.clipboard.pasteImage`   | Linux: `Ctrl+V`; macOS: `Ctrl+V`, `Cmd+V`; Windows: `Ctrl+V`, `Alt+V` | Paste from the clipboard (image preferred, text fallback)                                                                                                                            |
| `app.stt.toggle`             | `ctrl+space` (reserved)                                              | Record a complete utterance for native xAI transcription. Press once to record and again to stop; pauses never split the recording. Uses existing xAI credentials independently of configured dictation. Ctrl+Space is system-reserved: user overrides of this binding are ignored, Ctrl+Space is stripped from every other binding, and extension shortcuts on it are refused. |
| `app.dictation.toggle`       | `ctrl+alt+space`                                                      | Toggle the configured Dictation model. The separate Space-hold gesture also uses this pipeline and requires `stt.enabled`: hold Space to talk, release to stop. Press Backspace while holding Space to latch the recording; after releasing, tap Space or Backspace to stop. Neither route stops a Ctrl+Space recording. |
| `app.live.toggle`            | `Ctrl+L`                                                              | Start or stop live voice mode (same as `/live`). The composer stays usable during the call; your speech types into it.                                                                |
| `app.live.mute`              | `Alt+Shift+M`                                                         | Mute or unmute the microphone during live voice mode                                                                                                                                 |
| `app.live.destination.cycle` | `Ctrl+Alt+L`                                                          | During live voice mode, cycle where Enter sends composer text: main agent (default) → voice agent only → both. Slash, `!`, and `$` commands always go to the harness. The status-line mic shows `voice` or `both` when not sending to the main agent. |
| `app.agents.hub`             | `Alt+A`                                                               | [Open the Agent Hub](./agent-hub.md)                                                                                                                                                 |
| `app.irc.viewer`             | `Alt+I`                                                               | [Open the IRC communications viewer](./agent-hub.md#irc-viewer)                                                                                                                      |
| `app.sidebar.toggle`         | `Alt+T`                                                               | [Side panel view chord](#side-panel-views): then `t` Todo, `a` Agents, `i` IRC                                                                                                        |
| `app.tree.previousBranch`    | Unbound                                                               | Jump to the previous visible branch in `/tree` ([details](./tree.md))                                                                                                                |
| `app.tree.nextBranch`        | Unbound                                                               | Jump to the next visible branch in `/tree` ([details](./tree.md))                                                                                                                    |
| `app.links.hint` | Unbound | Tag visible extension links for activation; assign a binding in keybindings. NeoPi retains `Alt+O` for menu history forward. |
| `app.approval.approve` | `Ctrl+Enter`, `Ctrl+Q` | Approve a pending tool call; Esc denies. |
| `app.local.open` | `Alt+G` | Pick a session local file for the external editor. |
| `app.session.pin` | `Alt+K` | Pin the selected resume-picker session. |
| `app.session.unpin` | `Alt+Shift+K` | Unpin the selected resume-picker session. |

`Ctrl+G` opens `$VISUAL` / `$EDITOR` with the currently painted terminal viewport above `<!-- omp:message starts here -->`. The visible conversation and status are reference only: saving sends just the text below that marker back to the composer. Keep the marker intact; removing it leaves the original draft unchanged.

## Menu navigation

Menus, pickers, and overlays open in normal navigation; arrows, PageUp/PageDown, Home/End, Enter, and Esc keep working beside the Vim keys.

| Keys | Action |
| --- | --- |
| `j` / `k` | Next / previous row |
| `h` / `l` | Surface-dependent: switch pane, collapse/expand, reorder, or adjust a value (the hint line names it) |
| `Ctrl+D` / `Ctrl+U` (`tui.select.halfPageDown` / `halfPageUp`) | Half page down / up; PageDown / PageUp move a full page |
| `gg` / `G` (also `tui.select.first` / `last`: Home / End) | First / last row |
| `Ctrl+E` / `Ctrl+Y` (`tui.select.scrollDown` / `scrollUp`) | Scroll the view one line; the selection stays put until the next motion |
| `Space` (`tui.select.toggle`) | Toggle a checkbox or existing radio control, or confirm a nondestructive single-choice row; destructive and credential actions require Enter |
| `Tab` / `Shift+Tab`, also `Ctrl+N` / `Ctrl+P` (`tui.select.nextContext` / `prevContext`) | Next / previous tab, section, or focus region; an existing surface-specific binding takes precedence |
| `/` (`tui.select.search`) | Focus the search or filter field |

While a search, rename, or form field has focus, every printable key (including `h`, `j`, `k`, `l`, `g`, `/`, Space) types literally and the field keeps its editing keys. Search fields consume navigation keys while editing: arrows and page keys do not move the list. Enter confirms the pattern and returns to navigation without activating a result; Esc clears the search and returns to the unfiltered list. Press `/` again to edit the retained pattern. Rename and form fields keep their own submit/cancel behavior. Esc on a nested page returns to its parent; Esc at the root closes.

The prompt-history search (`Ctrl+R`) and move-path chooser are search-first exceptions: their text field opens focused. Pure viewers use `j`/`k` and `Ctrl+E`/`Ctrl+Y` to scroll a line, half/page keys for larger movement, and `gg`/`G` for top/bottom.

Advisor, chain, and persona roots use `h`/`l` to switch between their list and preview; the preview accepts viewer motions, and Enter on the list opens a detail page. Existing radio-with-editor rows keep Space activation and Enter editing. Inside nested configuration pages, `h` returns to the parent and `l` opens a navigable child, never an action.

Ask choices use ordinary list paging unless the selected answer's preview is taller than the viewport. For that oversized preview, PageUp/PageDown keep reading its content; row and half-page motions still change the choice, and `Ctrl+E`/`Ctrl+Y` always scroll the viewport without selecting or submitting an answer.

In Ask, `a` adds a separate note to the highlighted offered option without selecting it. Repeat it for more notes, including on options you will not choose. `A` edits that option's latest note; submitting an empty edit removes that note. `n` keeps the existing single answer-level note. Option notes stay attached to their original labels when selections change and are included in review and the agent's answer.

Nested configuration pages are history visits too. Back/forward inside an open menu restores its page without closing it. Tabs, sections, panes, and reply-field focus are contexts saved in the current snapshot, not extra visits. Blocking approvals and authentication challenges are not history destinations and cannot be dismissed or replayed by history. A focused prompt reports “Finish or cancel the prompt first”; a custom view reports “Close this view first (Esc)” because its one-shot result cannot be replayed. Two-press destructive confirmations are discarded on departure, never revived.

One-shot custom dialogs are excluded from history even when built in: the `/move` directory chooser, annotation source/code/text review dialogs, plan-save path chooser, experiment dashboard, and interactive shell. Their internal controls still follow the menu or literal-text contract; history never replays a filesystem action, review result, save, or live shell command. Plan approval is likewise a blocking decision, not a history destination.

Native TSP lists and pickers retain selection, filtering, and history. Their terminal consumer owns scrolling and the protocol does not expose a viewport position, so `Ctrl+E`/`Ctrl+Y` cannot scroll their native viewport independently; they never move the selection as a substitute. Native viewers forward line, page, and start/end requests, but half-page and absolute viewport restoration are unsupported. Native Git diffs also cannot restore a hunk cursor/range. ANSI menus and viewers support the full navigation and viewport contract.

`Ctrl+O` and `Ctrl+I` walk a timeline of visited views: each reopenable menu and return to the conversation is an entry. Esc out of `/statusline`, press `Ctrl+O`, and `/statusline` reopens where you left it; `Ctrl+I` returns to the conversation. Opening a menu from an older position adds it at the newest end without dropping the newer entries, and `Ctrl+O` from that new menu first returns to where you opened it: after `Ctrl+O` from `/statusline` back to the conversation and opening `/model`, `Ctrl+O` returns to the conversation, `Ctrl+I` to `/statusline`, and `Ctrl+I` again to `/model`.

### Menu search

Press `/` to enter pattern mode. Nothing filters until Enter confirms the draft and returns to navigation. Arrows, Tab and Ctrl-keys stay in the field while typing; they cannot switch panes or move results. Esc cancels and clears the search. Leaving the field without Enter discards its edits.

In settings, Esc restores the tab, section sidebar focus, selected setting and scroll position from before `/`. After confirmation, the footer shows normal navigation, including half-page and boundary motions, instead of pattern-entry hints.

Ordinary patterns use fuzzy matching, but punctuation-bearing words match their literal spelling rather than losing punctuation: `.{1000}` does not search for `1000`. Use `/pattern/` for **Vim search syntax, very-magic by default**. From navigation, type `//^claude/` then Enter: the first slash opens the field, and `/^claude/` is the pattern. The existing `/pattern` and `re:pattern` forms use the same dialect. Invalid or unsupported expressions show an inline error and match nothing.

| Pattern text | Meaning |
| --- | --- |
| `/live\|voice/` or `re:live\|voice` | Match either `live` or `voice` (the pattern contains a bare pipe) |
| `/<voice>/` | Match the whole word `voice`, not `revoice` |
| `/^(live\|voice)\s\d+$/` | Bare groups/alternation, whitespace, one or more digits |
| `/\CVoice/` / `/\cVoice/` | Case-sensitive / case-insensitive matching (the default is insensitive) |

Very-magic mode treats punctuation such as `|`, `()`, `+`, `?`, and `{n,m}` as operators without backslashes. `<` / `>` mark word start/end; `\d`, `\w`, and `\s` remain character classes. Escape punctuation to match it literally. Use `\m` inside a pattern for Vim's default-magic dialect (`/\m\(live\|voice\)`); `\M` and `\V` select nomagic and very-nomagic modes. These menu patterns do not change the ECMAScript `re:` syntax used by saved model selectors.

Supported search atoms:

- Literal text, dot, anchors, alternation, capturing and noncapturing groups (`%(` in very-magic, `\%(` in default-magic), backreferences `\1`–`\9`, and word boundaries. Default-magic `^` / `$` are literal away from branch boundaries.
- Greedy and lazy repetition: `*`, `+`, `?` / `=`, `{n,m}` and `{-}` / `{-n,m}` in very-magic; the corresponding Vim backslash forms in default-magic.
- Vim character classes `\a`, `\l`, `\u`, `\d`, `\x`, `\o`, `\h`, `\w`, `\s`, `\p` and their uppercase complements; `\l` and `\u` remain case-specific. Collections support ranges, negation and POSIX classes (`alnum`, `alpha`, `blank`, `cntrl`, `digit`, `graph`, `lower`, `print`, `punct`, `space`, `upper`, `xdigit`, `return`, `tab`, `escape`, `backspace`). Collection escapes follow Vim: `[\d]` matches a literal `d`, not a digit.
- Postfix lookaround (`@=`, `@!`, `@<=`, `@<!` in very-magic; `\@…` in default-magic), case flags, magic switches, and `\zs` / `\ze` for row membership. Menu search tests whether a row matches; it does not expose match-span boundaries.

This is not a complete Vim engine. Unknown atoms, numeric/positional `%` atoms, atomic `@>` groups, conjunction/replacement atoms, and collating/equivalence collections are rejected rather than silently interpreted as literal letters.


## Side panel views

`app.sidebar.toggle` (`Alt+T`) is a chord prefix. The next key picks what the side panel shows:

| Chord | View |
| --- | --- |
| `Alt+T` `t` | Todo list |
| `Alt+T` `a` | Agents: this session's subagents and advisors, as in the Agent Hub |
| `Alt+T` `i` | IRC: the newest agent-to-agent messages, from the same history as `Alt+I` |

From hidden, a chord opens the panel on that view; with another view showing, it switches; the chord of the view already showing hides the panel. The view key also works with `Alt` still held (`Alt+T` `Alt+A`). The prefix waits two seconds. `Esc` cancels it, and any other key cancels it and keeps its usual meaning. A right-click inside the panel cycles Todo → Agents → IRC. The chosen view persists as `sidebar.view`.

Wide terminals dock the panel beside the chat; below `sidebar.splitAt` the chord opens it fullscreen instead. While docked, the Todo view replaces the todo list above the editor and the Agents view replaces the pinned subagents list; each comes back when the panel closes or switches view. Other activity rows, such as waiting on subagents, stay where they are.

In the Agents view, hovering highlights a row. Clicking a subagent shows its transcript in the main area, the same as selecting it in the Agent Hub; clicking it again, or empty panel space, returns to the main session. Advisors and aborted agents are read-only transcripts, so clicking one opens the Agent Hub. Clicking the IRC view opens the full IRC viewer.
### Click to dictate in Tern

With `stt.enabled` on, the native composer shows a microphone beside Send. Click it to start recording without holding a key. While the speech model loads, the button shows **Starting…**; click it again to cancel. Once it changes to **Recording · Stop**, click it to stop, then wait for **Transcribing…** to finish.

Dictation started with this button stays in the draft, regardless of `stt.submitTrigger`. Review or edit the text, then press Enter or click Send. While dictation is recording or transcribing into the draft, Enter and Send do nothing.

For live English transcription, select **Nemotron 0.6B (live streaming, English)** in `omp setup speech`, or set `modelRoles.dictation` to `local/nemotron-streaming-en-0.6b`. Words appear in the draft while you speak. The first recording waits for the model to load before opening the microphone; start speaking when the button says **Recording · Stop**. Later recordings reuse the loaded model. See [local speech models](local-models.md#speech-to-text) for download and language details.
## Recover a cleared prompt

Press `Ctrl+C` to clear an unsent composer draft, then `Up` to recall it. Older drafts and submitted prompts share the existing Up/Down navigation. Recalled drafts remain editable and are never sent until you submit them.

Cleared drafts preserve whitespace, collapsed pastes, and image attachments in the current editor's bounded history (100 entries). They are not written to persistent prompt history and do not appear in `Ctrl+R` search. Closing the process discards these canceled drafts; the separate save-on-exit behavior still applies to text currently in the composer. This is not a per-agent stash: history follows the editor, including when Agent Hub changes focus.

The existing double-`Ctrl+C` exit behavior is unchanged. Empty clears do not add history entries.

Recovery is on by default. Turn off **Recall Cleared Drafts** in `/settings` under Interaction > Input, or set `composer.recallClearedDrafts: false`. This takes effect on the next clear without restarting; previously retained drafts remain in history until evicted or the editor closes.

On Windows Terminal, `Ctrl+V` may be handled by the terminal paste command before `omp` sees it; use the `Alt+V` fallback when clipboard image paste appears to do nothing. When the clipboard holds no image, `app.clipboard.pasteImage` pastes the clipboard text instead, so hosts that deliver only this chord (VS Code's integrated terminal when configured to forward `Ctrl+V`, Windows clipboard history via `Win+V`) work for both payload kinds. Windows Terminal also swallows `Ctrl+Enter`, so the `app.message.followUp` chord also binds `Ctrl+Q` — the same chord GitHub Copilot CLI uses — and the same chord submits the agent dashboard's new-agent description and hook-editor prompts. If your existing `keybindings.yml` already assigns `Ctrl+Q` to another action, that user remap wins and follow-up keeps `Ctrl+Enter` unless you explicitly bind `app.message.followUp`.

Terminals that implement OSC 5522 enhanced paste can send clipboard MIME data directly to `omp`; image pastes are attached as `[Image #N]`, while text/plain paste events keep normal paste behavior. When OSC 5522 is unavailable, bracketed paste still handles text, and a pasted single image-file path is loaded as an image when the file is readable from the `omp` host.

Older unqualified action names are migrated when `keybindings.yml` is loaded, but new docs and new configs should use the namespaced action IDs above. Existing `keybindings.json` files are still accepted and migrated to `keybindings.yml`; `keybindings.yaml` is also accepted.

## Vim editing mode

Off by default. Turn it on with **Vim Editing Mode** in `/settings` (Interaction → Input), or set it directly:

```yaml
tui.vimMode: true
```

The prompt starts in Insert mode. `Escape` switches to Normal mode; the prompt border changes color to show the mode (bash/python mode colors take precedence). The software cursor underlines the current character in Insert mode and uses a block in Normal mode; at line end Insert uses a bar, and Visual mode highlights the selection. The terminal cursor shape is set via DECSCUSR to a bar in Insert and a block in Normal/Visual, and restored on exit. This is a useful subset of Vim, not a full implementation.

The status line also shows the mode, pending command, and multi-line Visual selection size. **Vim Mode Indicator** (`tui.vimModeDisplay`) selects `text` (default), `icon`, or `none` (hides the whole Vim status segment).

| Mode        | Enter with              | Leave with                             |
| ----------- | ----------------------- | -------------------------------------- |
| Insert      | `i` `a` `I` `A` `o` `O` | `Escape`                               |
| Normal      | `Escape` from Insert    | any Insert-mode key                    |
| Visual      | `v`                     | `Escape`, or an operator (`y` `d` `c`) |
| Visual line | `V`                     | `Escape`, or an operator (`y` `d` `c`) |

### Normal mode

| Keys                      | Meaning                                                                                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `h` `j` `k` `l`           | Move by character and line (arrow keys work too)                                                                                                                                  |
| `0` `^` `$`               | Line start / first non-blank / line end                                                                                                                                           |
| `w` `b` `e`               | Next word, previous word, end of word                                                                                                                                             |
| `f` `F` `t` `T` + char    | Find / till that character on the line (`;` repeats, `,` reverses)                                                                                                                |
| `gg` `G`                  | First line, last line (`5gg` and `5G` jump to line 5)                                                                                                                             |
| `1`–`9` prefix            | Repeat a motion or operator, e.g. `3w`, `5j`, `2dd`                                                                                                                               |
| `i` `a` `I` `A`           | Insert before / after cursor, at line start / line end                                                                                                                            |
| `o` `O`                   | Open a line below / above and insert                                                                                                                                              |
| `x` `D` `C`               | Delete character, delete to line end (`2D` takes `count` lines), change to line end (`2C` likewise)                                                                               |
| `r` + char                | Replace the character under the cursor (`3rx` replaces three)                                                                                                                     |
| `R`                       | Replace mode: typed characters overwrite until Escape                                                                                                                             |
| `%`                       | Jump to the matching `()` `[]` `{}` `"` `'` on or after the cursor. Quotes stay on the line; brackets can cross lines. With a count, `50%` goes to that percentage of the buffer. |
| `{` `}`                   | Previous / next paragraph (blank-line boundary)                                                                                                                                   |
| `J`                       | Join lines, dropping the indent of the following line (an empty line joins without a space)                                                                                       |
| `>>` `<<`                 | Indent / outdent by two spaces (`3>>` shifts three lines; `>}` shifts a motion). Empty lines are left alone.                                                                      |
| `d` `y` `c` + motion      | Operate over a motion, e.g. `dw`, `d$`, `yb`, `cw`                                                                                                                                |
| `dd` `yy` `cc`            | Linewise delete / yank / change                                                                                                                                                   |
| `d` `y` `c` + text object | Operate over a text object, e.g. `diw`, `ca(`, `ci"`, `dap`                                                                                                                       |
| `p` `P`                   | Put the last yank or delete after / before the cursor                                                                                                                             |
| `u`                       | Undo (a whole Insert session, or a whole `.`, undoes in one step)                                                                                                                 |
| `.`                       | Repeat the last change, including text typed in the Insert session it opened; a count replaces the original one (`3.`)                                                            |

### Text objects

A text object follows an operator (`diw`) or extends a Visual selection (`viw`). `i` takes the inside, `a` takes the surroundings; counts apply, e.g. `d2aw`.

| Object              | Covers                                                                 |
| ------------------- | ---------------------------------------------------------------------- |
| `iw` `aw`           | Word; `aw` also takes the adjoining whitespace                         |
| `iW` `aW`           | Whitespace-delimited WORD                                              |
| `i"` `i'` `` i` ``  | Inside the quotes on the current line (`a"` takes the quotes too)      |
| `i(` `i[` `i{` `i<` | Inside the innermost matching pair, nesting-aware and across lines     |
| `a(` `a[` `a{` `a<` | The same pair including its delimiters (`b` and `B` alias `(` and `{`) |
| `ip` `ap`           | Paragraph — the run of non-blank (or blank) lines, linewise            |

### Visual mode

`v` starts a character-wise selection and `V` a line-wise one; motions move the free end. `y` copies the selection to the system clipboard (and to the internal register, so `p` puts it back), `d` deletes it, and `c` deletes it and drops into Insert mode. `x` deletes like `d`, and `s` changes like `c`. `o` jumps to the other end of the selection. `Escape` cancels.

A selection that would cut through an attachment placeholder such as `[Image #1, 800x600]` or `[Paste #2, +30 lines]` takes the whole placeholder with it, so a delete can never leave a corrupt fragment behind.

### Escape

`Escape` is shared with the app-level interrupt, so Vim mode takes it only when it has something to do:

- **Insert mode** → switch to Normal mode (an open autocomplete popup gets the first Escape to dismiss it).
- **Visual mode**, or a half-typed count or operator → cancel back to a quiet Normal mode.
- **Replace mode** (`R`) → switch to Normal mode, stepping back onto the last overwritten character.
- **Normal mode with nothing pending** → falls through to app behavior: dismiss autocomplete, abort active work, or run the configured double-Escape action with an empty editor. An idle main-session draft is preserved; bash/python and focused-agent views have their own Escape behavior.

Vim keys never shadow app chords: `Ctrl`-combinations, `Enter`, and `Tab` keep their normal behavior in every mode, so `Enter` still submits from Normal mode. Such a key also cancels a half-typed command (`d`, `r`, `f`) first, so the command never carries over into the next prompt. Prompt history stays on `Up`/`Down` in Insert mode only — in Normal mode those keys are `k` and `j`, so navigating a multi-line draft never loads a previous prompt.
