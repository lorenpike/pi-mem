import { complete } from "@mariozechner/pi-ai";
import {
	DynamicBorder,
	getMarkdownTheme,
	withFileMutationQueue,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Container, Markdown, matchesKey, Text } from "@mariozechner/pi-tui";

const MEMORY_HEADER = "# Memories";
const MEMORY_DIRECTORY_RELATIVE_PATH = ".mem";
const MEMORY_FILE_RELATIVE_PATH = ".mem/memories.md";
const MEMORY_GITIGNORE_RELATIVE_PATH = ".mem/.gitignore";
const DEFAULT_MEMORY_GITIGNORE_CONTENT = "*\n";
const MEMORY_CONTEXT_TYPE = "mem-context";
const MEM_COMMAND_USAGE = 'Usage: /mem status | /mem show | /mem "memory text"';
const MANUAL_MEMORY_TAGGING_SYSTEM_PROMPT = `You convert a raw user note into a single durable memory entry for pi.

Return exactly one line in the form [tag] content.

Allowed tags:
- [goal]
- [fact]
- [preference]
- [decision]
- [process]
- [open]
- [link]

Rules:
- Return only the tagged memory entry.
- No list number, quotes, markdown fences, or commentary.
- Keep it to one line.
- Rewrite first-person references so the memory is self-contained, e.g. "my favorite color is orange" -> "User's favorite color is orange".
- Prefer [fact] for stable facts, [preference] for likes/dislikes or style preferences, [decision] for chosen approaches, [process] for recurring workflow reminders, [goal] for durable objectives, [open] for unresolved questions, and [link] for references to docs/files.
- Do not invent details that were not stated.
- Strip any trailing period.`;
const ALLOWED_TAGS = ["goal", "fact", "preference", "decision", "process", "open", "link"] as const;
const ALLOWED_TAG_SET = new Set<string>(ALLOWED_TAGS);
const ALLOWED_TAG_LIST = ALLOWED_TAGS.map((tag) => `[${tag}]`).join(", ");
const MULTILINE_ERROR =
	"Memory entries must be a single line. Write the detailed content to documentation, then save a descriptive [link] memory instead.";

type MemoryTag = (typeof ALLOWED_TAGS)[number];

export interface MemoryEntry {
	tag: MemoryTag;
	content: string;
}

interface MemoryMutationResult {
	path: string;
	number: number;
	entry: string;
	count: number;
}

interface MemoryUpdateResult extends MemoryMutationResult {
	previousEntry: string;
}

function getMemoryDirectoryPath(cwd: string): string {
	return resolve(cwd, MEMORY_DIRECTORY_RELATIVE_PATH);
}

function getMemoryFilePath(cwd: string): string {
	return resolve(cwd, MEMORY_FILE_RELATIVE_PATH);
}

function getMemoryGitignorePath(cwd: string): string {
	return resolve(cwd, MEMORY_GITIGNORE_RELATIVE_PATH);
}

function assertNotAborted(signal?: AbortSignal) {
	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}
}

function stripOptionalListPrefix(input: string): string {
	return input.replace(/^\s*(?:\d+\.\s+|[*-]\s+)/, "").trim();
}

function stripOptionalWrappingQuotes(input: string): string {
	const trimmed = input.trim();
	if (trimmed.length < 2) {
		return trimmed;
	}

	const startsWithDoubleQuote = trimmed.startsWith('"') && trimmed.endsWith('"');
	const startsWithSingleQuote = trimmed.startsWith("'") && trimmed.endsWith("'");
	if (!startsWithDoubleQuote && !startsWithSingleQuote) {
		return trimmed;
	}

	return trimmed.slice(1, -1).trim();
}

function extractTaggedMemoryCandidate(input: string): string {
	const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
	const withoutFence = normalized.replace(/^```[a-zA-Z0-9_-]*\n?/, "").replace(/\n```$/, "").trim();
	const lines = withoutFence
		.split("\n")
		.map((line) => stripOptionalListPrefix(line.trim()))
		.filter(Boolean);

	for (const line of lines) {
		if (/^\[[^\]]+\]\s+.+$/.test(line)) {
			return stripOptionalWrappingQuotes(line);
		}
	}

	return stripOptionalWrappingQuotes(withoutFence);
}

function extractResponseText(content: unknown): string {
	if (!Array.isArray(content)) {
		return "";
	}

	return content
		.filter((block): block is { type: string; text: string } => {
			return Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string";
		})
		.map((block) => block.text)
		.join("\n")
		.trim();
}

export function normalizeMemoryInput(input: string): MemoryEntry {
	const normalizedInput = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (normalizedInput.includes("\n")) {
		throw new Error(MULTILINE_ERROR);
	}

	const stripped = stripOptionalListPrefix(normalizedInput.trim());
	if (!stripped) {
		throw new Error(`Memory entry must be in the form [tag] content. Allowed tags: ${ALLOWED_TAG_LIST}.`);
	}

	const tagAndContentMatch = /^\[([^\]]+)\]\s+(.+)$/.exec(stripped);
	if (!tagAndContentMatch) {
		throw new Error(`Memory entry must be in the form [tag] content. Allowed tags: ${ALLOWED_TAG_LIST}.`);
	}

	const rawTag = tagAndContentMatch[1];
	if (!ALLOWED_TAG_SET.has(rawTag)) {
		if (ALLOWED_TAG_SET.has(rawTag.toLowerCase())) {
			throw new Error(`Memory tags must be lowercase. Use [${rawTag.toLowerCase()}].`);
		}
		throw new Error(`Memory tag must be one of: ${ALLOWED_TAG_LIST}.`);
	}

	const normalizedContent = tagAndContentMatch[2].trim().replace(/\.+$/g, "").trim();
	if (!normalizedContent) {
		throw new Error("Memory content cannot be empty.");
	}

	return {
		tag: rawTag as MemoryTag,
		content: normalizedContent,
	};
}

export function formatMemoryText(entry: MemoryEntry): string {
	return `[${entry.tag}] ${entry.content}`;
}

export function parseMemoriesMarkdown(markdown: string): MemoryEntry[] {
	const normalized = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const lines = normalized.split("\n");
	const entries: MemoryEntry[] = [];

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index].trim();
		if (!line || line === MEMORY_HEADER) {
			continue;
		}

		try {
			entries.push(normalizeMemoryInput(line));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Invalid memory line ${index + 1}: ${message}`);
		}
	}

	return entries;
}

export function formatMemoriesMarkdown(entries: MemoryEntry[]): string {
	if (entries.length === 0) {
		return `${MEMORY_HEADER}\n`;
	}

	return `${MEMORY_HEADER}\n\n${entries.map((entry, index) => `${index + 1}. ${formatMemoryText(entry)}`).join("\n")}\n`;
}

async function ensureMemoryStore(cwd: string): Promise<string> {
	const memoryDirectoryPath = getMemoryDirectoryPath(cwd);
	const memoryFilePath = getMemoryFilePath(cwd);
	const memoryGitignorePath = getMemoryGitignorePath(cwd);
	await mkdir(memoryDirectoryPath, { recursive: true });

	try {
		await access(memoryGitignorePath);
	} catch {
		await writeFile(memoryGitignorePath, DEFAULT_MEMORY_GITIGNORE_CONTENT, "utf8");
	}

	try {
		await access(memoryFilePath);
	} catch {
		await writeFile(memoryFilePath, `${MEMORY_HEADER}\n`, "utf8");
	}

	return memoryFilePath;
}

async function loadMemoryStore(cwd: string): Promise<{ path: string; entries: MemoryEntry[]; raw: string }> {
	const memoryFilePath = await ensureMemoryStore(cwd);
	const raw = await readFile(memoryFilePath, "utf8");

	try {
		return {
			path: memoryFilePath,
			entries: parseMemoriesMarkdown(raw),
			raw,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse ${MEMORY_FILE_RELATIVE_PATH}: ${message}`);
	}
}

async function writeMemoryStore(memoryFilePath: string, entries: MemoryEntry[]): Promise<void> {
	await mkdir(dirname(memoryFilePath), { recursive: true });
	await writeFile(memoryFilePath, formatMemoriesMarkdown(entries), "utf8");
}

async function loadMemoryBlock(cwd: string): Promise<string> {
	const memoryFilePath = await ensureMemoryStore(cwd);
	const raw = await readFile(memoryFilePath, "utf8");

	try {
		return formatMemoriesMarkdown(parseMemoriesMarkdown(raw));
	} catch {
		const trimmed = raw.trim();
		return trimmed ? `${trimmed}\n` : `${MEMORY_HEADER}\n`;
	}
}

async function addMemoryEntry(cwd: string, entryText: string, signal?: AbortSignal): Promise<MemoryMutationResult> {
	assertNotAborted(signal);
	const memoryFilePath = getMemoryFilePath(cwd);

	return withFileMutationQueue(memoryFilePath, async () => {
		assertNotAborted(signal);
		const nextEntry = normalizeMemoryInput(entryText);
		const store = await loadMemoryStore(cwd);
		const entries = [...store.entries, nextEntry];
		await writeMemoryStore(store.path, entries);
		const number = entries.length;

		return {
			path: store.path,
			number,
			entry: formatMemoryText(nextEntry),
			count: entries.length,
		};
	});
}

async function updateMemoryEntry(cwd: string, number: number, entryText: string, signal?: AbortSignal): Promise<MemoryUpdateResult> {
	assertNotAborted(signal);
	const memoryFilePath = getMemoryFilePath(cwd);

	return withFileMutationQueue(memoryFilePath, async () => {
		assertNotAborted(signal);
		const nextEntry = normalizeMemoryInput(entryText);
		const store = await loadMemoryStore(cwd);
		const index = number - 1;
		if (index < 0 || index >= store.entries.length) {
			throw new Error(`Memory ${number} does not exist in ${MEMORY_FILE_RELATIVE_PATH}. Current memory count: ${store.entries.length}.`);
		}

		const previousEntry = store.entries[index];
		const entries = [...store.entries];
		entries[index] = nextEntry;
		await writeMemoryStore(store.path, entries);

		return {
			path: store.path,
			number,
			previousEntry: formatMemoryText(previousEntry),
			entry: formatMemoryText(nextEntry),
			count: entries.length,
		};
	});
}

async function deleteMemoryEntry(cwd: string, number: number, signal?: AbortSignal): Promise<MemoryMutationResult> {
	assertNotAborted(signal);
	const memoryFilePath = getMemoryFilePath(cwd);

	return withFileMutationQueue(memoryFilePath, async () => {
		assertNotAborted(signal);
		const store = await loadMemoryStore(cwd);
		const index = number - 1;
		if (index < 0 || index >= store.entries.length) {
			throw new Error(`Memory ${number} does not exist in ${MEMORY_FILE_RELATIVE_PATH}. Current memory count: ${store.entries.length}.`);
		}

		const removedEntry = store.entries[index];
		const entries = store.entries.filter((_, entryIndex) => entryIndex !== index);
		await writeMemoryStore(store.path, entries);

		return {
			path: store.path,
			number,
			entry: formatMemoryText(removedEntry),
			count: entries.length,
		};
	});
}

function buildMemoryStatusText(path: string, count: number): string {
	return `mem: ${count} memories in ${path}`;
}

async function classifyManualMemoryText(rawText: string, ctx: ExtensionCommandContext): Promise<string> {
	try {
		return formatMemoryText(normalizeMemoryInput(rawText));
	} catch {
		// Fall through to off-session tagging model call.
	}

	if (!ctx.model) {
		throw new Error("No model selected. Select a model first, or pass a tagged entry like [fact] ...");
	}

	const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
	if (!apiKey) {
		throw new Error(`No API key available for ${ctx.model.provider}/${ctx.model.id}.`);
	}

	const response = await complete(
		ctx.model,
		{
			systemPrompt: MANUAL_MEMORY_TAGGING_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: rawText }],
					timestamp: Date.now(),
				},
			],
		},
		{ apiKey, maxTokens: 80, reasoningEffort: "minimal" },
	);

	if (response.stopReason === "aborted") {
		throw new Error("Memory tagging was aborted.");
	}

	const responseText = extractResponseText(response.content);
	const candidate = extractTaggedMemoryCandidate(responseText);
	return formatMemoryText(normalizeMemoryInput(candidate));
}

async function showMemoriesUi(markdown: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/mem show requires interactive mode", "warning");
		return;
	}

	await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
		const container = new Container();
		const border = new DynamicBorder((text: string) => theme.fg("accent", text));
		const markdownTheme = getMarkdownTheme();

		container.addChild(border);
		container.addChild(new Text(theme.fg("accent", theme.bold("Memories")), 1, 0));
		container.addChild(new Text(theme.fg("dim", MEMORY_FILE_RELATIVE_PATH), 1, 0));
		container.addChild(new Markdown(markdown, 1, 1, markdownTheme));
		container.addChild(new Text(theme.fg("dim", "Press Enter or Esc to close"), 1, 0));
		container.addChild(border);

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
					done(undefined);
				}
			},
		};
	});
}

async function handleMemCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const trimmedArgs = args.trim();
	if (!trimmedArgs) {
		ctx.ui.notify(MEM_COMMAND_USAGE, "info");
		return;
	}

	if (trimmedArgs === "status") {
		const store = await loadMemoryStore(ctx.cwd);
		ctx.ui.notify(buildMemoryStatusText(store.path, store.entries.length), "info");
		return;
	}

	if (trimmedArgs === "show") {
		const markdown = await loadMemoryBlock(ctx.cwd);
		await showMemoriesUi(markdown, ctx);
		return;
	}

	const rawText = stripOptionalWrappingQuotes(trimmedArgs);
	if (!rawText) {
		ctx.ui.notify(MEM_COMMAND_USAGE, "info");
		return;
	}

	const directEntry = (() => {
		try {
			return formatMemoryText(normalizeMemoryInput(rawText));
		} catch {
			return undefined;
		}
	})();

	if (!directEntry && ctx.hasUI) {
		ctx.ui.notify("mem: tagging memory...", "info");
	}

	const entryText = directEntry ?? (await classifyManualMemoryText(rawText, ctx));
	const result = await addMemoryEntry(ctx.cwd, entryText);
	ctx.ui.notify(`Added memory ${result.number} in ${MEMORY_FILE_RELATIVE_PATH}: ${result.entry}`, "success");
}

export default function memExtension(pi: ExtensionAPI) {
	pi.on("context", async (event, ctx) => {
		const memoryBlock = await loadMemoryBlock(ctx.cwd);
		const messages = event.messages.filter((message) => {
			const candidate = message as { role?: string; customType?: string };
			return !(candidate.role === "custom" && candidate.customType === MEMORY_CONTEXT_TYPE);
		});

		return {
			messages: [
				{
					role: "custom",
					customType: MEMORY_CONTEXT_TYPE,
					content: memoryBlock,
					display: false,
					timestamp: Date.now(),
				},
				...messages,
			],
		};
	});

	pi.registerTool({
		name: "mem",
		label: "Mem",
		description: "Save a durable one-line memory entry for the current working directory.",
		promptSnippet: `Save a durable one-line memory entry to ${MEMORY_FILE_RELATIVE_PATH}`,
		promptGuidelines: [
			"Use mem only for durable project context such as goals, facts, preferences, decisions, processes, open questions, and links.",
			"Before adding a memory, check the current # Memories block. If an existing memory already captures the same durable information, prefer mem_update or skip adding a duplicate.",
			"Pass memory text as `[tag] content`. Do not include list numbers or bullets.",
			"If the memory needs more than one line, write project documentation first and store a descriptive [link] memory instead.",
		],
		parameters: Type.Object({
			entry: Type.String({
				description: `Single-line memory entry in the form [tag] content. Allowed tags: ${ALLOWED_TAG_LIST}.`,
			}),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await addMemoryEntry(ctx.cwd, (params as { entry: string }).entry, signal);

			return {
				content: [{ type: "text", text: `Added memory ${result.number} in ${MEMORY_FILE_RELATIVE_PATH}: ${result.entry}` }],
				details: {
					action: "add",
					path: result.path,
					number: result.number,
					entry: result.entry,
					count: result.count,
				},
			};
		},
	});

	pi.registerTool({
		name: "mem_update",
		label: "Mem Update",
		description: "Update an existing durable memory entry by its number.",
		promptSnippet: `Update a numbered memory entry in ${MEMORY_FILE_RELATIVE_PATH}`,
		promptGuidelines: [
			"Use the memory number shown in the current # Memories block.",
			"Pass replacement text as `[tag] content`. Do not include list numbers or bullets.",
			"Prefer updating an existing memory when a durable fact or decision changes instead of adding a duplicate.",
			"If the replacement needs more than one line, write documentation first and update the memory to a descriptive [link] instead.",
		],
		parameters: Type.Object({
			number: Type.Integer({ minimum: 1, description: "The memory number to update." }),
			entry: Type.String({
				description: `Replacement memory entry in the form [tag] content. Allowed tags: ${ALLOWED_TAG_LIST}.`,
			}),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { number, entry } = params as { number: number; entry: string };
			const result = await updateMemoryEntry(ctx.cwd, number, entry, signal);

			return {
				content: [
					{
						type: "text",
						text: `Updated memory ${number} in ${MEMORY_FILE_RELATIVE_PATH}: ${result.previousEntry} -> ${result.entry}`,
					},
				],
				details: {
					action: "update",
					path: result.path,
					number,
					previousEntry: result.previousEntry,
					entry: result.entry,
					count: result.count,
				},
			};
		},
	});

	pi.registerTool({
		name: "mem_delete",
		label: "Mem Delete",
		description: "Delete an existing durable memory entry by its number.",
		promptSnippet: `Delete a numbered memory entry from ${MEMORY_FILE_RELATIVE_PATH}`,
		promptGuidelines: [
			"Use the memory number shown in the current # Memories block.",
			"Delete a memory when it is obsolete or incorrect and should no longer be carried forward.",
			"Remember that remaining memories will be renumbered after deletion because the file uses a chronological ordered list.",
		],
		parameters: Type.Object({
			number: Type.Integer({ minimum: 1, description: "The memory number to delete." }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { number } = params as { number: number };
			const result = await deleteMemoryEntry(ctx.cwd, number, signal);

			return {
				content: [{ type: "text", text: `Deleted memory ${number} from ${MEMORY_FILE_RELATIVE_PATH}: ${result.entry}` }],
				details: {
					action: "delete",
					path: result.path,
					number,
					entry: result.entry,
					count: result.count,
				},
			};
		},
	});

	pi.registerCommand("mem", {
		description: "Manage memories: /mem status, /mem show, or /mem \"memory text\"",
		getArgumentCompletions: (prefix) => {
			const trimmedPrefix = prefix.trim();
			const items = [
				{ value: "status", label: "status — show memory count and file path" },
				{ value: "show", label: "show — render memories in the UI" },
			];
			const filtered = items.filter((item) => item.value.startsWith(trimmedPrefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			try {
				await handleMemCommand(args, ctx);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`mem: ${message}`, "error");
			}
		},
	});
}
