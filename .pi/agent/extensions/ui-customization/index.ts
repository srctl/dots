import { homedir } from "node:os";
import { relative } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  emptyGitInfoState,
  emptyModelInfoState,
  GIT_INFO_CHANNEL,
  MODEL_INFO_CHANNEL,
  REFRESH_CHANNEL,
  isGitInfoState,
  isModelInfoState,
} from "../shared/dashboard-state.ts";

type Rgb = [number, number, number];
interface RenderableNode {
  children?: RenderableNode[];
  invalidate(): void;
  render(width: number): string[];
}

interface DashboardTui extends RenderableNode {
  requestRender(force?: boolean): void;
}

const VIM_MODE_STATUS = "vim-mode";
const LENS_LSP_STATUS = "pi-lens-lsp";
const LENS_DIAGNOSTICS_EVENT = "pilens:diagnostics";

interface ProblemCounts {
  errors: number;
  warnings: number;
}

interface LensDiagnosticsEvent {
  files: Array<{ path: string; diagnostics: Array<{ severity: string }> }>;
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const PALETTE: Rgb[] = [
  [22, 83, 189],
  [48, 129, 247],
  [93, 171, 255],
  [151, 205, 255],
  [93, 171, 255],
  [48, 129, 247],
];
const TITLE_LINES = [
  "  ██████╗  ██╗ ",
  "  ██╔══██╗ ██║ ",
  "  ██████╔╝ ██║ ",
  "  ██╔═══╝  ██║ ",
  "  ██║      ██║ ",
  "  ╚═╝      ╚═╝ ",
];
const ANSI_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
// eslint-disable-next-line no-control-regex
const OSC_PATTERN =
  /(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c)/g;
// eslint-disable-next-line no-control-regex
const CSI_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ESCAPE_PATTERN = /\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])/g;

function sanitizeTerminalLabel(text: string) {
  return text
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESCAPE_PATTERN, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

function mix(a: number, b: number, amount: number) {
  return Math.round(a + (b - a) * amount);
}

function sampleGradient(position: number) {
  const wrapped = ((position % 1) + 1) % 1;
  const scaled = wrapped * PALETTE.length;
  const index = Math.floor(scaled);
  const nextIndex = (index + 1) % PALETTE.length;
  const amount = scaled - index;
  const start = PALETTE[index]!;
  const end = PALETTE[nextIndex]!;

  return [
    mix(start[0], end[0], amount),
    mix(start[1], end[1], amount),
    mix(start[2], end[2], amount),
  ] satisfies Rgb;
}

function foreground([red, green, blue]: Rgb, text: string) {
  return `\x1b[38;2;${red};${green};${blue}m${text}${RESET}`;
}

function gradientText(text: string, phase: number) {
  const characters = [...text];
  const span = Math.max(characters.length - 1, 1);

  return characters
    .map((character, index) =>
      character === " "
        ? character
        : foreground(sampleGradient(index / span + phase), character),
    )
    .join("");
}

function hasChildren(
  component: RenderableNode,
): component is RenderableNode & { children: RenderableNode[] } {
  return Array.isArray(component.children);
}

function renderedText(component: RenderableNode) {
  try {
    return component.render(200).join("\n").replace(ANSI_PATTERN, "");
  } catch {
    return "";
  }
}

function hideThemesSection(component: RenderableNode) {
  if (!hasChildren(component)) return false;

  for (let index = 0; index < component.children.length; index += 1) {
    const child = component.children[index]!;
    const firstLine = renderedText(child)
      .split("\n")
      .find((line) => line.trim())
      ?.trim();

    if (firstLine === "[Themes]") {
      const removeCount =
        component.children[index + 1] &&
        renderedText(component.children[index + 1]!).trim() === ""
          ? 2
          : 1;
      component.children.splice(index, removeCount);
      component.invalidate();
      return true;
    }

    if (hideThemesSection(child)) return true;
  }

  return false;
}

function formatDirectory(cwd: string) {
  const home = homedir();
  if (cwd === home) return "~";
  const display = cwd.startsWith(`${home}/`) ? `~/${relative(home, cwd)}` : cwd;
  return sanitizeTerminalLabel(display);
}

function isLensDiagnosticsEvent(value: unknown): value is LensDiagnosticsEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { files?: unknown }).files)
  );
}

function vimModeColor(mode: string): ThemeColor {
  if (mode.endsWith("INSERT")) return "success";
  if (mode.includes("VISUAL")) return "warning";
  return "accent";
}

function formatProblems(
  problemsByFile: Map<string, ProblemCounts>,
  theme: Theme,
) {
  let errors = 0;
  let warnings = 0;
  for (const counts of problemsByFile.values()) {
    errors += counts.errors;
    warnings += counts.warnings;
  }

  const parts = [];
  if (errors > 0) parts.push(theme.fg("error", `●${errors}E`));
  if (warnings > 0) parts.push(theme.fg("warning", `!${warnings}W`));
  return parts.join(" ");
}

function center(text: string, width: number) {
  const padding = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
  return truncateToWidth(`${" ".repeat(padding)}${text}`, width);
}

function columns(left: string, right: string, width: number) {
  if (!right) return truncateToWidth(left, width);

  const naturalGap = width - visibleWidth(left) - visibleWidth(right);
  if (naturalGap >= 1) return `${left}${" ".repeat(naturalGap)}${right}`;

  const leftWidth = Math.max(1, Math.floor(width * 0.45));
  const rightWidth = Math.max(1, width - leftWidth - 1);
  const fittedLeft = truncateToWidth(left, leftWidth);
  const fittedRight = truncateToWidth(right, rightWidth);
  const gap = Math.max(
    1,
    width - visibleWidth(fittedLeft) - visibleWidth(fittedRight),
  );
  return truncateToWidth(
    `${fittedLeft}${" ".repeat(gap)}${fittedRight}`,
    width,
  );
}

export default function uiCustomization(pi: ExtensionAPI) {
  let title = "pi";
  let modelInfo = emptyModelInfoState();
  let gitInfo = emptyGitInfoState();
  let requestRender: (() => void) | undefined;
  let activeTui: DashboardTui | undefined;
  let themeRemovalTimers: Array<ReturnType<typeof setTimeout>> = [];

  const stopModelListener = pi.events.on(MODEL_INFO_CHANNEL, (value) => {
    if (!isModelInfoState(value)) return;
    modelInfo = value;
    requestRender?.();
  });

  const stopGitListener = pi.events.on(GIT_INFO_CHANNEL, (value) => {
    if (!isGitInfoState(value)) return;
    gitInfo = value;
    requestRender?.();
  });

  // pi-lens re-sends the full diagnostic list for each file it re-checks, and
  // an empty list once a file is clean, so replacing by path keeps the totals
  // current. These counts stand in for pi-lens's multi-line widget, which is
  // hidden in ~/.pi-lens/config.json.
  const problemsByFile = new Map<string, ProblemCounts>();
  const stopDiagnosticsListener = pi.events.on(
    LENS_DIAGNOSTICS_EVENT,
    (value) => {
      if (!isLensDiagnosticsEvent(value)) return;
      for (const file of value.files) {
        const severities = file.diagnostics.map((d) => d.severity);
        const errors = severities.filter((s) => s === "error").length;
        const warnings = severities.filter((s) => s === "warning").length;
        if (errors + warnings === 0) problemsByFile.delete(file.path);
        else problemsByFile.set(file.path, { errors, warnings });
      }
      requestRender?.();
    },
  );

  function scheduleThemeRemoval(tui: DashboardTui) {
    for (const timer of themeRemovalTimers) clearTimeout(timer);
    themeRemovalTimers = [];

    for (const delay of [0, 50, 250, 1_000]) {
      themeRemovalTimers.push(
        setTimeout(() => {
          if (hideThemesSection(tui)) tui.requestRender(true);
        }, delay),
      );
    }
  }

  function install(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;

    ctx.ui.setHeader((tui) => {
      activeTui = tui;
      requestRender = () => tui.requestRender();
      scheduleThemeRemoval(tui);

      return {
        render(width: number) {
          const art = TITLE_LINES.map((line, row) =>
            center(gradientText(line, row * 0.045), width),
          );
          const subtitle = center(
            `${BOLD}${gradientText(title, 0.18)}${RESET}`,
            width,
          );
          return ["", ...art, subtitle, ""];
        },
        invalidate() {},
      };
    });

    ctx.ui.setFooter((tui, theme, footerData: ReadonlyFooterDataProvider) => {
      requestRender = () => tui.requestRender();

      return {
        invalidate() {},
        render(width: number) {
          const statuses = new Map(footerData.getExtensionStatuses());

          // The Vim mode leads the row, like a Vim statusline.
          const vimMode = statuses.get(VIM_MODE_STATUS);
          statuses.delete(VIM_MODE_STATUS);
          const mode = vimMode
            ? `${theme.bold(theme.fg(vimModeColor(vimMode), vimMode))}  `
            : "";

          // Diagnostic counts sit beside pi-lens's LSP indicator.
          const problems = formatProblems(problemsByFile, theme);
          if (problems) {
            const lsp = statuses.get(LENS_LSP_STATUS);
            statuses.set(LENS_LSP_STATUS, lsp ? `${lsp} ${problems}` : problems);
          }

          const directory = theme.fg("text", formatDirectory(ctx.cwd));
          const branch = gitInfo.branch
            ? theme.fg("muted", ` · ${gitInfo.branch}`)
            : "";
          const left = `${mode}${directory}${branch}`;
          const model = theme.fg(
            "muted",
            modelInfo.provider
              ? `${modelInfo.provider}/${modelInfo.modelId} · ${modelInfo.thinking}`
              : modelInfo.modelId,
          );

          const separator = theme.fg("muted", " · ");
          const statusText = Array.from(statuses.entries())
            .filter(([, text]) => text.trim())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, text]) => text.replace(/\s*\n\s*/g, " "))
            .join(separator);
          if (!statusText) return [columns(left, model, width)];

          // Statuses share the row with the model when everything fits, and
          // move to a second row when the terminal is too narrow.
          const right = `${statusText}${separator}${model}`;
          if (visibleWidth(left) + visibleWidth(right) < width) {
            return [columns(left, right, width)];
          }
          return [
            columns(left, model, width),
            truncateToWidth(statusText, width, theme.fg("dim", "...")),
          ];
        },
      };
    });

    ctx.ui.setTitle(`pi · ${title}`);
    pi.events.emit(REFRESH_CHANNEL, undefined);
  }

  pi.on("session_start", (_event, ctx) => {
    title = formatDirectory(ctx.cwd);
    modelInfo = emptyModelInfoState();
    gitInfo = emptyGitInfoState();
    problemsByFile.clear();
    install(ctx);
  });

  pi.on("resources_discover", () => {
    if (activeTui) scheduleThemeRemoval(activeTui);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopModelListener();
    stopGitListener();
    stopDiagnosticsListener();
    for (const timer of themeRemovalTimers) clearTimeout(timer);
    themeRemovalTimers = [];
    activeTui = undefined;
    requestRender = undefined;
    if (ctx.mode === "tui") {
      ctx.ui.setHeader(undefined);
      ctx.ui.setFooter(undefined);
    }
  });
}
