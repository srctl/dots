import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

const ANIMATION_DURATION_MS = 140;
const FRAME_INTERVAL_MS = 16;
const WIDGET_KEY = "smooth-scroll";

type ScrollRenderer = TUI & {
	scrollBy(lines: number): void;
};

type ScrollBy = (this: ScrollRenderer, lines: number) => void;

type ScrollPrototype = {
	scrollBy?: ScrollBy;
};

type Animation = {
	distance: number;
	applied: number;
	startedAt: number;
	timer?: ReturnType<typeof setTimeout>;
};

function installSmoothScroll(tui: TUI): () => void {
	const renderer = tui as Partial<ScrollRenderer>;
	if (tui.mode !== "fullscreen" || typeof renderer.scrollBy !== "function") return () => {};

	// Patch the renderer instance's real prototype. Importing TuiAltScreen here
	// can resolve to a separate package copy from the one Pi is running.
	const prototype = Object.getPrototypeOf(renderer) as ScrollPrototype;
	const originalScrollBy = prototype.scrollBy;
	if (!originalScrollBy) return () => {};

	const animations = new Map<ScrollRenderer, Animation>();

	const patchedScrollBy: ScrollBy = function (lines) {
		if (!Number.isFinite(lines) || Math.abs(lines) <= 1) {
			originalScrollBy.call(this, lines);
			return;
		}

		const current = animations.get(this);
		if (current?.timer) clearTimeout(current.timer);

		// Preserve the unfinished distance when repeated keys arrive, so quick
		// presses accumulate instead of repeatedly restarting from zero.
		const remaining = current ? current.distance - current.applied : 0;
		const distance = remaining + Math.trunc(lines);
		if (distance === 0) {
			animations.delete(this);
			return;
		}

		const animation: Animation = {
			distance,
			applied: 0,
			startedAt: performance.now(),
		};
		animations.set(this, animation);

		const tick = () => {
			if (animations.get(this) !== animation) return;

			const progress = Math.min(1, (performance.now() - animation.startedAt) / ANIMATION_DURATION_MS);
			const easedProgress = 1 - (1 - progress) ** 3;
			const nextApplied = Math.round(animation.distance * easedProgress);
			const delta = nextApplied - animation.applied;
			animation.applied = nextApplied;

			if (delta !== 0) originalScrollBy.call(this, delta);

			if (progress === 1) {
				animations.delete(this);
				return;
			}

			animation.timer = setTimeout(tick, FRAME_INTERVAL_MS);
		};

		animation.timer = setTimeout(tick, 0);
	};

	prototype.scrollBy = patchedScrollBy;

	return () => {
		for (const animation of animations.values()) {
			if (animation.timer) clearTimeout(animation.timer);
		}
		animations.clear();

		// Do not overwrite a later extension that wrapped our patch.
		if (prototype.scrollBy === patchedScrollBy) prototype.scrollBy = originalScrollBy;
	};
}

export default function smoothScrollExtension(pi: ExtensionAPI) {
	let uninstall: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		// A component factory is the supported way for an extension to receive
		// Pi's actual TUI renderer. Returning no lines keeps the widget invisible.
		ctx.ui.setWidget(WIDGET_KEY, (tui) => {
			uninstall?.();
			const cleanup = installSmoothScroll(tui);
			uninstall = cleanup;

			return {
				render: () => [],
				invalidate() {},
				dispose() {
					cleanup();
					if (uninstall === cleanup) uninstall = undefined;
				},
			};
		});
	});

	pi.on("session_shutdown", () => {
		uninstall?.();
		uninstall = undefined;
	});
}
