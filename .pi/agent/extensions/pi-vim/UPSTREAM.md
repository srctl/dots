# pi-vim-flash

**Your Pi conversation is now a Vim buffer.**

`pi-vim-flash` adds Vim-style prompt editing and Flash.nvim-inspired navigation to [Pi](https://pi.dev). Jump to visible transcript text with incremental labels, press `v`/`V` when you want Visual mode, yank assistant output without touching the mouse, and open rendered links from the keyboard.

## Why this exists

Most modal editor extensions stop at the input prompt. `pi-vim-flash` also treats Pi's rendered transcript—user messages, assistant responses, code blocks, and tool output—as a keyboard-navigable surface.

That changes the common “find something useful above, reach for the mouse, drag a fragile selection, copy it” workflow into one keyboard sequence:

- **Jump instead of scroll:** type one or more visible characters and choose a home-row label.
- **Act at the destination:** flash jumps land in Normal mode so `v`/`V` remains explicit Vim muscle memory.
- **Select with Vim motions:** start selection when you want it, then extend across wrapped responses, code, Markdown, and tool output.
- **Copy what Pi actually rendered:** syntax colors and layout stay visible while selecting; `y` copies the selected transcript text.
- **Keep the same muscle memory in the prompt:** use counts, operators, text objects, registers, Visual mode, and familiar Vim motions below the transcript too.

The defining feature is not merely “Vim keys in a text box.” It is making the whole Pi conversation feel like one actionable Vim surface.

## Demo

![Flash-style transcript navigation in Pi](https://raw.githubusercontent.com/kungfusaini/pi-vim-flash/main/demo/pi-vim-flash.gif)

The demo is recorded from the real Pi TUI and shows the complete workflow—not just the jump:

1. `Ctrl-U` scrolls up through earlier tool output.
2. `s` + `◆` overlays home-row labels on visible transcript matches.
3. `d` chooses the target, then `v` starts selection and `0` extends it across the line.
4. `y` yanks the highlighted transcript text.
5. `q` returns to the prompt and `p` puts the yank into the editor.
6. `f"` + `ci"` changes the quoted text, then `A` appends a final comment.

The result is a mouse-free round trip from old agent output to editable prompt text.

### The signature workflow

From Normal mode with an empty prompt:

1. Press `s`.
2. Type one or more characters visible in the transcript; matches narrow and labels update as you type.
3. Type the label displayed over the match.
4. The cursor jumps there in Normal mode.
5. Press `v`/`V` if you want to select, then extend with `h`, `j`, `k`, `l`, `w`, `b`, `e`, `0`, or `$`.
6. Press `y` to copy the rendered transcript selection.

For links, press `S` with an empty prompt. Actual rendered terminal hyperlinks are labeled; type a label to open the link in your OS browser.

For message-level navigation, press `J` or `K` from Normal mode with an empty prompt to move between user messages. The selected user message is aligned to the top of the transcript and marked with a `▌` gutter. Press `Enter` on that selected message to open actions for destructive edit or tree-style navigation.

The overlay reuses Pi's native rendered transcript components, preserving Markdown, syntax highlighting, tool output, and message styling.

## Install

Try it without installing:

```bash
pi -e npm:pi-vim-flash
```

Install globally:

```bash
pi install npm:pi-vim-flash
```

Restart Pi after installation.

For local development:

```bash
pi -e ./src/index.ts
```

## Prompt editing

Press `Esc` to enter Normal mode. Press `i` to return to Insert mode.

### Modes

| Key | Action |
|---|---|
| `Esc` | Insert → Normal; cancel a pending Normal-mode command |
| `i`, `a` | Insert at / after cursor |
| `I`, `A` | Insert at first non-whitespace / end of line |
| `o`, `O` | Open line below / above |
| `v`, `V` | Visual / Visual Line mode |

### Motions

Most motions accept a count, such as `3w`, `2j`, and `4e`.

| Keys | Action |
|---|---|
| `h j k l` | Character and line movement |
| `w b e` | Keyword-word motions |
| `W B E` | Whitespace-delimited WORD motions |
| `0 ^ $` | Line start, first non-whitespace, line end |
| `gg`, `G` | Prompt start / end; `{count}gg` and `{count}G` jump to a line |
| `{`, `}` | Previous / next paragraph |
| `%` | Matching `()`, `[]`, or `{}` delimiter |
| `f F t T{char}` | Find / till a character on the current line |
| `;`, `,` | Repeat the last character-find forward / reversed |

### Operators and edits

| Keys | Action |
|---|---|
| `d{motion}`, `c{motion}`, `y{motion}` | Delete, change, or yank by motion |
| `dd`, `cc`, `yy`, `Y` | Linewise operation |
| `D`, `C`, `S` | Delete to EOL, change to EOL, change line |
| `x`, `r{char}` | Delete / replace characters |
| `p`, `P` | Put after / before using the unnamed register |
| `u` | Undo through Pi's editor |
| `J`, `gJ` | Join lines with / without normalized spacing |

Counts compose with motions and operators: `3x`, `2dd`, `d3w`, and `2d3w`.

### Text objects

Use text objects with `d`, `c`, or `y`:

- Words: `iw`, `aw`, `iW`, `aW`
- Quotes: `i"`, `a"`, `i'`, `a'`, ``i` ``, ``a` ``
- Pairs: `i(`/`a(`, `i[`/`a[`, `i{`/`a{` and their closing-delimiter aliases

Examples: `ciw`, `di"`, `ya{`.

### Visual mode

Visual and Visual Line modes support:

- Motions: `h j k l w b 0 $`
- Flash jump: `s{query}{label}`
- Operations: `y`, `d`, `x`, `c`

## Transcript navigation

With an empty prompt in Normal mode:

| Keys | Action |
|---|---|
| `s{query}{label}` | Incremental Flash jump; lands in Normal mode |
| `S{label}` | Label actual rendered links and open the chosen link |
| `k`, `j` | Scroll one row |
| `J`, `K` | Move to next / previous user message without wrapping; align it to the top and show a `▌` gutter marker |
| `Enter` | When a user message is selected with `J`/`K`, open message actions |
| `Ctrl-U`, `Ctrl-D` | Scroll half a page |
| `gg`, `G` | Transcript top / bottom |
| `v` | Toggle selection at the transcript cursor |
| `h j k l w b e 0 $` | Extend transcript selection |
| `y` | Copy selected rendered text |
| `i`, `a` | Return to prompt Insert mode |
| `q`, `Esc` | Close transcript navigation |

### Selected user-message actions

After selecting a user message with `J` or `K`, press `Enter` to choose:

- **Edit message (destructive)**: restores the selected user message into Pi's input buffer and physically removes that message plus all later entries from the current session file, including assistant responses and labels after it.
- **Fork from here (tree navigation)**: uses Pi's tree navigation flow from the selected message. It asks whether to summarize the abandoned branch (`No summary`, `Summarize`, or `Summarize with custom prompt`) before navigating.

Because destructive edit rewrites the current Pi session JSONL file, use it only when you really want to discard later conversation history in that session.

## Inspiration and related projects

`pi-vim-flash` exists because two excellent plugins proved how good label-based movement and modal prompt editing can feel:

- **[flash.nvim](https://github.com/folke/flash.nvim)** by [folke](https://github.com/folke) inspired the `s` → search character → home-row label interaction. Flash.nvim brings search labels, enhanced character motions, and structural navigation to Neovim; this package adapts the core label-jump idea to Pi's rendered transcript and turns the destination into a Visual selection anchor.
- **[pi-vim](https://github.com/lajarre/pi-vim)** by [lajarre](https://github.com/lajarre) is a comprehensive modal editor for Pi's input prompt and helped establish the expected Vim command surface in Pi. If your priority is broad, highly tested prompt-editing parity, it is absolutely worth checking out. `pi-vim-flash` is an independent implementation whose defining focus is unified prompt **and transcript** navigation, Visual selection, and yanking.

Both projects are MIT-licensed. Many thanks to their authors and contributors for the inspiration and for pushing modal navigation forward.

## Intentional differences from Vim

- `s` launches Flash instead of substituting the character under the cursor. Flash navigation is the package's primary feature.
- Visual Block mode, redo, search (`/`, `?`, `n`, `N`), macros, named registers, repeat (`.`), and a full Ex command line are not implemented.
- Transcript selection operates on rendered terminal text. Copied code may therefore reflect wrapping and visible tool formatting.

## Clipboard support

Yanks and register-writing edits maintain an internal unnamed register and mirror it best-effort to:

- macOS: `pbcopy` / `pbpaste`
- Wayland: `wl-copy` / `wl-paste`
- X11: `xclip` or `xsel`
- Windows: `clip` / PowerShell `Get-Clipboard`

Immediate delete/yank → put works through the internal register even if no system clipboard utility is available.

## Compatibility

Tested against the minimum supported Pi `0.80.6`, Pi `0.80.10`, and Pi `0.84.1`; CI also checks the latest published Pi release.

`0.1.4` adds incremental Flash queries, distinct colored labels, Normal-mode transcript jumps, and `S` link flash for actual rendered terminal hyperlinks.

`0.1.3` updates transcript scrollback detection for Pi `0.84`'s mounted TUI layout. If scrolling opens a blank transcript or makes output appear to disappear, upgrade to `pi-vim-flash@0.1.3` or newer.

Transcript navigation uses some non-public Pi TUI/editor/session internals to render the native conversation inside an overlay and to support destructive user-message editing. Those APIs can change between Pi releases. Supported Pi versions will be tested and documented as the package evolves.

## Development

```bash
npm install
npm run check
```

Re-record the MP4 and GIF demo with [VHS](https://github.com/charmbracelet/vhs), `bat`, and `ffmpeg` installed:

```bash
./demo/render.sh
```

`npm run check` runs strict TypeScript checking and 52 unit/integration tests. Coverage includes editor key sequences, modes, counts, ranges, linewise edge cases, registers, text objects, character-find behavior, prompt and transcript Flash targets, rendered ANSI selection, extension lifecycle cleanup, and transcript Visual yanking.

## Security

Pi extensions execute with your user permissions. Review extensions before installation. This package invokes local clipboard utilities and, when you use `S` link flash, your OS browser opener (`open`, `xdg-open`, `gio open`, or Windows `start`). It does not make network requests itself.

## License

MIT
