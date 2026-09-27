// Used only by the offline PTY smoke test; never auto-loaded by pi-vim.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function responseFixture(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    pi.sendMessage({
      customType: "pi-vim-smoke-test",
      content: [
        ...Array.from({ length: 60 }, (_, index) => `Response line ${index}.`),
        "Last response line.",
      ].join("\n"),
      display: true,
    });
  });
}
