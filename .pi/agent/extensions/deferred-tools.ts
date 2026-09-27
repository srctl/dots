import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const LOADER_TOOL = "activate_tools";
const BASELINE_TOOLS = ["read", "bash", "edit", "write", "fffind", "ffgrep", "lsp_diagnostics", LOADER_TOOL];
const IGNORED_QUERY_WORDS = new Set(["a", "an", "and", "for", "in", "of", "the", "to", "tool", "tools", "use", "with"]);

function normalize(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function scoreTool(tool: ToolInfo, query: string, terms: string[]): number {
	const name = normalize(tool.name);
	const description = normalize(tool.description);
	const source = normalize(`${tool.sourceInfo.source} ${tool.sourceInfo.path}`);

	if (name === query) return 1000;

	let score = name.includes(query) ? 100 : 0;
	for (const term of terms) {
		if (name.split(" ").includes(term)) score += 30;
		else if (name.includes(term)) score += 15;
		if (source.includes(term)) score += 5;
		if (description.includes(term)) score += 2;
	}
	return score;
}

function activationResult(text: string, matches: string[] = [], added: string[] = []) {
	return { content: [{ type: "text" as const, text }], details: { matches, added } };
}

function findExplicitMatches(tools: ToolInfo[], rawQuery: string, limit: number): string[] {
	const query = rawQuery.toLowerCase().replace(/[^a-z0-9_]+/g, " ").trim();
	const paddedQuery = ` ${query} `;
	return tools
		.filter((tool) => {
			if (tool.name === LOADER_TOOL) return false;
			const name = tool.name.toLowerCase();
			return name.includes("_") ? paddedQuery.includes(` ${name} `) : query === name;
		})
		.slice(0, limit)
		.map((tool) => tool.name);
}

function findMatches(tools: ToolInfo[], query: string, terms: string[], limit: number): string[] {
	const scored: Array<{ tool: ToolInfo; score: number }> = [];
	for (const tool of tools) {
		if (tool.name === LOADER_TOOL) continue;
		const score = scoreTool(tool, query, terms);
		if (score > 0) scored.push({ tool, score });
	}

	scored.sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name));
	return scored.slice(0, limit).map((match) => match.tool.name);
}

function activateMatchingTools(pi: ExtensionAPI, params: { query: string; limit?: number }) {
	const query = normalize(params.query);
	const terms = query.split(" ").filter((term) => term && !IGNORED_QUERY_WORDS.has(term));
	if (!query || terms.length === 0) {
		return activationResult("Use a capability or exact tool name to search for tools.");
	}

	const active = new Set(pi.getActiveTools());
	const tools = pi.getAllTools();
	const limit = params.limit ?? 3;
	const explicitMatches = findExplicitMatches(tools, params.query, limit);
	const matches = explicitMatches.length > 0 ? explicitMatches : findMatches(tools, query, terms, limit);
	if (matches.length === 0) return activationResult(`No registered tools matched: ${params.query}`);

	const added = matches.filter((name) => !active.has(name));
	if (added.length > 0) pi.setActiveTools([...active, ...added]);

	const alreadyActive = matches.filter((name) => active.has(name));
	const lines: string[] = [];
	if (added.length > 0) lines.push(`Activated: ${added.join(", ")}`);
	if (alreadyActive.length > 0) lines.push(`Already active: ${alreadyActive.join(", ")}`);
	return activationResult(lines.join("\n"), matches, added);
}

function applyInitialTools(pi: ExtensionAPI): void {
	const available = new Set(pi.getAllTools().map((tool) => tool.name));

	// A strict CLI allowlist can omit the loader. In that case, leave the
	// caller's explicit tool selection untouched.
	if (!available.has(LOADER_TOOL)) return;

	pi.setActiveTools(BASELINE_TOOLS.filter((name) => available.has(name)));
}

export default function deferredTools(pi: ExtensionAPI) {
	let initialToolsApplied = false;

	pi.registerTool({
		name: LOADER_TOOL,
		label: "Activate Tools",
		description:
			"Search registered but inactive tools and activate the best matches. Search by capability (for example, 'web research' or 'LSP diagnostics') or exact tool name. Activated tools become available immediately after this result.",
		promptSnippet: "Search for and activate deferred tools by capability or exact name",
		promptGuidelines: [
			"Use activate_tools when a task needs a capability that is not in the active tool list; activated tools remain available for the rest of the session.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Capability or exact tool name to find" }),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, description: "Maximum tools to activate (default: 3)" })),
		}),
		execute(_toolCallId, params) {
			return Promise.resolve(activateMatchingTools(pi, params));
		},
	});

	pi.on("session_start", () => {
		initialToolsApplied = false;
		applyInitialTools(pi);
	});

	// Reapply once after every extension has finished its session_start work.
	// This makes the initial provider request lean regardless of extension load order.
	pi.on("before_agent_start", () => {
		if (initialToolsApplied) return;
		applyInitialTools(pi);
		initialToolsApplied = true;
	});
}
