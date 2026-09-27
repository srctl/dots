# pi-vim (local)

Standalone local Pi extension based on `pi-vim-flash` **0.1.5**, copied from the
npm package already installed for a trial on 2026-09-27.
Upstream: https://github.com/kungfusaini/pi-vim-flash
Original MIT license is retained in `LICENSE`; upstream documentation is in
`UPSTREAM.md`. This is not the separate `pi-vim` npm project.

## Loading

Pi automatically discovers `index.ts` in this directory. Start Pi normally;
**do not also pass `-e npm:pi-vim-flash`** or install the upstream package alongside
this extension. Two copies would register duplicate commands and editor handlers.

The old `~/.pi/agent/extensions/prompt-glyph.ts` is preserved but disabled by the
`-extensions/prompt-glyph.ts` exclusion in `~/.pi/agent/settings.json`.
There can only be one replacement editor.

For the first switch from the npm trial, restart Pi without `-e`; use
`pi --resume` to return to the conversation. Subsequent local edits can use `/reload`.

## Local changes

- Integrates the `❯` prompt glyph with two-column padding.
- Adjusts Visual selection and Flash labels for the padded prompt.
- Ctrl+P/Ctrl+N navigate autocomplete in Insert mode, leaving application shortcuts
  alone when autocomplete is closed.
- A visible response cursor and explicit character/line selection.
- Separated prompt editing, pane lifecycle, clipboard access, and message actions.

## Response pane keys

Press **Escape**, then **k** from the first line of the prompt to enter responses.
The cursor starts on the last nonblank line of the visible transcript. A draft
can remain in the prompt; it is not cleared or edited by response navigation.

| Key | Action |
| --- | --- |
| `h j k l` | Move the visible response cursor |
| `w b e`, `0 $` | Move by word, or to line start/end |
| `v` / `V` | Toggle character / whole-line selection |
| `y` | Copy selection; keep the response cursor active |
| `Ctrl+H` / `Ctrl+L` | Animate half a page up / down |
| `Ctrl+U` / `Ctrl+D` | Move half a page immediately |
| `gg` / `G` | First / last transcript line |
| `i` / `a` | Return to typing at the saved prompt cursor |
| `A` | Return to typing at the very end of the entire draft |
| `Escape` | Cancel selection/search first; otherwise return to prompt Normal mode |
| `q` | Return to prompt Normal mode |
| `s` / `S` | Optional Flash text jump / link jump |

Ctrl+H/Ctrl+L also enter responses from prompt Normal mode. Insert mode keeps
Pi's native Ctrl+L model picker and Ctrl+H backspace. Repeated scrolling keys
add distance; reversing direction changes course immediately. Other commands
stop the animation at its current position. `A` in prompt Normal mode also
appends to the end of the entire draft (not just the current line).

The footer shows `RESPONSES · NORMAL`, `VISUAL`, or `VISUAL LINE` while that pane
has the cursor. The transcript is read-only. Copied text reflects the rendered
line wrapping, not the original Markdown. Native mouse/image interaction still
belongs to Pi; leave the response overlay with `i` or `q` to use it.

See `UPSTREAM.md` for remaining prompt-editing keys (the table above overrides
its older transcript-navigation behavior). Upstream's destructive message-edit
command still deletes the selected message and all subsequent session entries;
use its fork/navigation alternative when you want to preserve history.

## Verification

Integration tests load the extension with the installed Pi's real extension loader
and exercise its editor. Set `PI_PACKAGE_ROOT` to the installed coding-agent package,
not the executable or the agent configuration directory. With the current Volta install:

```sh
cd ~/.pi/agent/extensions/pi-vim
PI_PACKAGE_ROOT="$(dirname "$(dirname "$(volta which pi)")")/lib/node_modules/@earendil-works/pi-coding-agent" \
  node --test test/local.test.mjs
~/.pi/agent/node_modules/.bin/tsc -p tsconfig.json
python3 test/tui-smoke.py
```

The 22 integration tests cover draft editing, pane navigation, selection, Unicode,
streaming updates, and resizing. The offline smoke test launches the real fullscreen
TUI in a temporary terminal; it makes no model call, saves no session, and leaves
the system clipboard alone.

The typecheck resolves the agent directory's development dependencies; the integration
tests resolve the current executable's dependencies, as Pi does when loading extensions.

## Reading the code

Start with `src/index.ts`, then follow the one feature you want to change:

- `src/prompt-editor.ts`: routes keys, tracks pending Vim commands, edits the draft.
- `src/parts/response-session.ts`: opens/closes the overlay, updates the footer,
  refreshes streaming content, and cleans up timers on shutdown.
- `src/parts/scrollback.ts`: response cursor, selection, Flash targets, rendering.
- `src/parts/vim-operations.ts`: pure string operations for motions/text objects.
- `src/parts/message-actions.ts`: session navigation and destructive message editing.
- `src/parts/system-clipboard.ts`: OS clipboard commands and opening links.
- `src/parts/types.ts`: shared mode and position types.

A **motion** moves the cursor; an **operator** applies an edit to a motion's range.
For example, `2dw` collects count `2`, operator `d`, then motion `w`. **Visual mode**
keeps an anchor where selection started and extends it to the current cursor.
A **register** is Vim's in-memory copy buffer, used even without a system clipboard.

Text offsets are JavaScript string offsets, not terminal columns. Rendering must
account for ANSI color codes and wide characters. The private Pi API calls are
commented at their use sites; these are compatibility boundaries, not general
patterns to copy into new code. The code favors ordinary functions, named steps,
and explicit branches over a generic Vim command framework.

## Maintenance / rollback

This is a local copy, so `pi update` will not overwrite it. Upstream updates are manual:
compare new source against version 0.1.5, retain the local changes above, and rerun tests.
A full pre-cursor snapshot is at `~/.pi/agent/pi-vim.before-response-cursor/`.
The transcript integration uses private Pi internals and needs checking after Pi updates.

To roll back, move this directory outside `extensions/`, remove the prompt-glyph
exclusion from settings, and restart. A pre-change settings backup is at
`~/.pi/agent/settings.json.before-local-pi-vim`; prefer removing only the exclusion
rather than overwriting any settings changed since that backup.
