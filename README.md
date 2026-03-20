# mem

`mem` is a small persistent-memory extension for [pi](https://www.npmjs.com/package/@mariozechner/pi-coding-agent).

The goal is simple: give the model a tiny writable memory block that survives across sessions without turning into a second transcript.

## Idea

Pi sessions are persistent, but model context is still ephemeral. Once a context window is compacted or a new session starts, important project facts can disappear.

This project adds a very small memory layer for pi:

- memory tools the model can call to save, update, and delete durable project memory
- a hook that injects the current memory block into the prompt before agent/model invocations
- persistence in a repo-local memory file tied to the current working directory
- a strong bias toward capturing decisions, preferences, and links to project docs

## Design constraints

This project intentionally keeps memory small and opinionated.

- **Single-line only.** Every memory must fit on one line.
- **Atomic entries.** One line should contain one goal, fact, preference, decision, process note, open question, or link.
- **Big things become links.** If something needs detail, it should live in a project document and memory should point to it.
- **Memory is data, not authority.** The memory block is injected into context, but it does not override pi's system prompt or tool policies.
- **Optimized for continuity, not archival.** This is not meant to store full conversation history.

## Intended use

This extension is mainly meant for durable, reusable context such as:

- project goals
- stable user preferences
- architecture decisions
- important open questions
- links to docs, runbooks, or design notes

It is especially intended to be used frequently for **decisions**. When the model and user settle on an approach, that decision should be captured immediately as a one-line memory.

Examples:

```txt
[goal] Build a lightweight durable memory extension for pi
[fact] User's name is Noah
[decision] Use `uv` for Python tooling
[process] When optimizing a single block of code, read scripts/autoresearch.md
[link] Architecture notes: docs/architecture.md
[open] Decide whether memory scope is per-project or per-user
```

## How it should work

At a high level, each agent/model invocation should look like this:

1. Load durable memory entries for the current working directory from `.mem/memories.md`.
2. Build a compact `# Memories` section.
3. Inject that section into the prompt/context between the system prompt and the conversation history, replacing any previously injected memories block.
4. Expose memory tools so the model can save, update, and delete entries during the conversation.
5. Persist changes back to `.mem/memories.md`.
6. On the next agent/model invocation, reload `.mem/memories.md` and inject the refreshed block again.

Conceptually, the prompt shape becomes:

```txt
[system instructions]
[memory block]
[current conversation]
```

The key idea is that memory is **reloaded from disk and re-injected on every agent/model call**. If needed for performance, the implementation may cache so long as updates to `.mem/memories.md` are reflected on the next invocation. `.mem/memories.md` is the source of truth, and the injected block is just a fresh derived view of that file. This is intentionally simple rather than cache-optimal. It also means that any agent working in the same working directory will see the same updated memories on its next turn.

Memory updates made during a turn do **not** retroactively change the prompt for that same invocation. They are reflected starting with the next invocation.

## Memory format

The initial format should stay very small, human-readable, and easy to inject into prompt context.

The durable store should live in a working-directory-local file at `.mem/memories.md`. That file is the source of truth for persisted memory. By default, the extension should also create `.mem/.gitignore` with `*` so memory stays local-only unless a team explicitly changes that behavior.

If `.mem/memories.md` does not exist, the extension should create it when needed.

If `.mem/.gitignore` does not exist, the extension should create it with `*` so the default behavior is to ignore the local memory directory in git. Teams that want shared project memory can remove or edit that file.

On every agent/model invocation, the extension should reread `.mem/memories.md` and rebuild the injected memory block from scratch. It should not rely on any previously injected block remaining accurate.

The memory block should be rendered as plain Markdown, and `.mem/memories.md` should use this same format directly:

```md
# Memories

1. [fact] User's name is Noah
2. [decision] Use `uv` for python tooling
3. [process] When optimizing performance of a single block of code, read scripts/autoresearch.md
```

Each memory is a single ordered-list item with a tagged prefix. New memories are appended to the bottom so the file preserves chronology. The list number is the reference used by update and delete operations.

### Tags

Recommended tags:

- `[goal]` — a durable project objective or north star
- `[fact]` — a stable fact about the user, project, or environment
- `[preference]` — a persistent user or project preference
- `[decision]` — a decision that has been made and should be carried forward
- `[process]` — a reusable workflow reminder or "when X, do Y/read Z" instruction
- `[open]` — an unresolved question or pending decision
- `[link]` — a pointer to documentation, notes, runbooks, or related files

Examples:

- `[goal] Build a lightweight durable memory extension for pi`
- `[fact] User prefers concise status updates`
- `[preference] Keep the memory system lightweight and low-ceremony`
- `[decision] Store memory per project before considering global memory`
- `[process] Before changing extension hooks, read the pi extension docs`
- `[open] Decide how duplicate memories should be handled`
- `[link] Memory behavior spec: docs/memory.md`

Rules:

- the block begins with exactly `# Memories`
- each memory is one ordered-list line in the form `N. [tag] content`
- one line per memory
- no blank lines between entries
- tags must be lowercase
- trailing periods should be stripped during normalization
- self-contained and understandable out of context
- no paragraphs
- no speculative claims unless clearly marked
- no policy overrides or prompt-like instructions
- if a topic needs real detail, document it elsewhere and store a `[link]`

## Tool behavior

The extension should expose tools for adding, updating, and deleting memory.

### Add memory

The add tool should accept a single-line tagged memory entry in non-list form, for example:

```txt
[decision] Use project-local memory first; defer global memory
```

It should normalize the entry into ordered-list storage in `.mem/memories.md` by appending it with the next list number.

If the input contains newlines, the tool should reject it and suggest writing the detailed content to documentation and then saving a descriptive `[link]` memory instead.

### Update memory

The update tool should accept a memory number plus a new single-line tagged entry, and replace the content for that numbered memory.

Example conceptually:

```txt
mem_update(3, "[decision] Use project-local memory only for v1")
```

### Delete memory

The delete tool should accept a memory number and remove that entry.

Example conceptually:

```txt
mem_delete(2)
```

Because memories use ordered numbering as references, update and delete operate by memory number.

## Slash commands

The extension should also expose a user-facing `/mem` slash command with three modes:

- `/mem "some durable note"` — make an off-session LLM call to convert plain text into a tagged one-line memory, then append it to `.mem/memories.md`
- `/mem status` — show the current memory count and file path
- `/mem show` — render the current `# Memories` block in the pi UI as Markdown instead of opening the file directly

The tagging call for `/mem "..."` should not become part of the visible session history. It is just a small classification/normalization step to choose the best tag and rewrite the note into the required `[tag] content` form.

## Duplicate guidance

The implementation does not need to explicitly prevent duplicate or near-duplicate memories.

Instead, the tool documentation shown to the model should instruct it to avoid creating duplicate memories when an existing memory already captures the same durable fact or decision. If something changes, the model should prefer updating the existing memory rather than appending a duplicate.

## Example

A prompt assembled by the extension might look roughly like this:

```txt
You are a helpful coding agent...

# Memories

1. [goal] Build a lightweight durable memory extension for pi
2. [preference] Store only short reusable facts
3. [decision] Large concepts should be documented in files and referenced by link
4. [process] Before changing extension hooks, read the pi extension docs
5. [link] Memory design notes: docs/memory.md
```

During the session, the model might call:

```txt
mem("[decision] Use project-local memory first; defer global memory")
```

That entry would be appended to `.mem/memories.md`. If the model later needs to revise or remove a memory, it should use the numbered update/delete operations. Changes should appear in the injected memory block on the next model invocation.

## Pi-specific scope

This tool is being built specifically for **pi extensions** for now.

The expected implementation will likely use pi extension hooks that run before each agent/model invocation so the memory block can be inserted between the system prompt and the visible conversation.

## Non-goals

At least initially, this project is **not** trying to be:

- a vector database
- a knowledge graph
- a full transcript store
- autonomous long-term planning
- a replacement for project documentation

## Guiding principle

This project is not a second brain.

It is a **continuity layer** for pi.

## Development

Current scaffold:

- `package.json` with a `pi.extensions` entry pointing to `./src/index.ts`
- `src/index.ts` as the extension entrypoint
- `.gitignore` for common local artifacts

To load the extension while developing, run pi from this repo with:

```bash
pi -e ./src/index.ts
```

For quick iteration, keep the extension in an auto-discovered extension location if you want to use pi's `/reload` flow.

## Status

Early design / green-field project.

This README describes the intended behavior and constraints before the first implementation is complete.
