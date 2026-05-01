# mem

A persistent-memory extension for [pi](https://www.npmjs.com/package/@mariozechner/pi-coding-agent).

Gives the model a tiny writable memory block that survives across sessions — without turning into a second transcript.

## What it does

- Stores one-line tagged memory entries in a repo-local `.mem/memories.md` file
- Injects the current memory block into the system prompt before each agent invocation
- Exposes a `mem` tool so the model can add, update, and delete entries during conversation
- Provides a `/mem` slash command for quick manual additions

Memory is reloaded from disk each session and kept in sync as changes happen. Any agent working in the same directory sees the same memories.

## Memory format

Each memory is a single tagged line:

```
1. [fact] User's name is Noah
2. [decision] Use `uv` for Python tooling
3. [process] Before changing hooks, read the pi extension docs
4. [link] Architecture notes: docs/architecture.md
```

Available tags: `[goal]`, `[fact]`, `[preference]`, `[decision]`, `[process]`, `[open]`, `[link]`

If something needs more than one line, write it to a document and store a `[link]` instead.

## Tool

The `mem` tool accepts three actions:

```
mem({ action: "add", entry: "[decision] Use project-local memory only" })
mem({ action: "update", number: 3, entry: "[decision] Use global memory" })
mem({ action: "delete", number: 2 })
```

## Slash command

- `/mem "some note"` — classifies and appends a tagged memory via an off-session LLM call
- `/mem status` — shows memory count and file path
- `/mem show` — renders the current memory block in the UI

## Installation

```bash
pi install git:git@github.com:lorenpike/pi-mem.git
```

Project-local:

```bash
pi install -l git:git@github.com:lorenpike/pi-mem.git
```

Try without installing:

```bash
pi -e git:git@github.com:lorenpike/pi-mem.git
```

## Development

Load the extension from this repo:

```bash
pi -e ./src/index.ts
```
