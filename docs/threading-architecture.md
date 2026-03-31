# Threading Architecture

## Background

NanoClaw was designed with a one-conversation-per-channel model. Every piece of state (GroupQueue, IPC directories, cursors, reactions) is keyed by channel. For our use case — Slack channels mapped to repos, with independent conversations per thread — this is a fundamental mismatch.

The desired model:
- **Channel = repo.** `#crm-inbox` points at the prospecting repo. Later, other channels may point at other repos.
- **Thread = conversation.** Each Slack thread is an independent Claude session with its own worktree.
- **Top-level message = new conversation.** Starts a fresh session and thread.
- **Thread reply = continuation.** Resumes the existing session for that thread.

## Design choice: in-container session multiplexer

We chose to run **one long-lived container per channel** with a **session multiplexer inside** that manages multiple concurrent Claude sessions (one per thread). Each session gets its own git worktree on an ephemeral branch.

### How it works

```
Slack #crm-inbox (channel = prospecting repo)
  +-- Container (one, long-lived)
        +-- Thread 1711234.5678 -> Session A, worktree /workspace/threads/1711234-5678
        +-- Thread 1711234.9999 -> Session B, worktree /workspace/threads/1711234-9999
        +-- Thread 1711235.1111 -> Session C, worktree /workspace/threads/1711235-1111
```

The host communicates with the container via typed IPC messages (`new_thread`, `message`, `close_thread`, `shutdown`). The container emits typed output markers (`result` for query results, `lifecycle` for ready/session_ended signals).

Git worktrees share the `.git` directory but have independent working trees. Each session pushes to main via `git push origin thread-{ts}:main`. If the remote moved, `git pull --rebase origin main` handles it.

### Alternative considered: thread-as-virtual-group

The simpler alternative: map each Slack thread to its own NanoClaw group, getting a separate container per thread. This would have been ~80 lines of changes across 3 files — almost entirely additive, no rewrites.

We did not take this approach. The tradeoffs:

| | Multiplexer (chosen) | Virtual-group (not chosen) |
|---|---|---|
| **VPS resources** | 1 container per channel | 1 container per active thread |
| **Memory (3 threads)** | ~300MB (shared runtime) | ~900MB (3x Node.js + SDK) |
| **New thread latency** | Instant (warm container) | 5-10s (cold container startup) |
| **Crash blast radius** | All threads in channel | Single thread |
| **Upstream divergence** | ~1000 lines, 7 files, 16% of codebase | ~80 lines, 3 files, additive |
| **Rebase difficulty** | Hard (agent runner rewrite) | Easy (mostly additive) |

The multiplexer wins on resources and latency, which matter on a small VPS. It loses on maintainability — this fork diverges significantly from upstream NanoClaw, and rebasing their changes (especially to the agent runner or index.ts) will require manual work.

If the operational constraints change (bigger VPS, fewer concurrent threads, desire to track upstream closely), the virtual-group approach remains available and would be straightforward to implement.

## Key components

### Agent runner (`container/agent-runner/src/index.ts`)
Session multiplexer. Manages `Map<threadTs, RunningSession>`. Creates worktrees, runs concurrent `query()` calls, reaps idle sessions.

### IPC protocol (`data/ipc/{groupFolder}/input/*.json`)
Typed messages replacing the old untyped `{text}` + `_close` sentinel:
- `new_thread` — start a session with optional resume
- `message` — send follow-up to existing session
- `close_thread` — end a specific session
- `shutdown` — gracefully close all sessions

### Container output (stdout markers)
Discriminated union on `type`:
- `{ type: 'result', status, result, threadTs, newSessionId }` — query result
- `{ type: 'lifecycle', event: 'ready' | 'session_ended', threadTs, newSessionId }` — lifecycle signal

### Tool allowlist (`/workspace/ipc/allowed-tools.json`)
Written by the host from `containerConfig.allowedTools`. Read-only to the agent — the agent cannot modify its own permissions. Falls back to a restrictive read-only set if not configured.

### Sessions DB
Composite key `(group_folder, thread_ts)` replacing the old single-key `group_folder`. Each thread gets its own persistent session ID for resume.

## Git worktree lifecycle

1. New thread arrives: `git worktree add -b thread-{ts} /workspace/threads/{ts} origin/main`
2. Set upstream: `git branch --set-upstream-to=origin/main`
3. Session works: edit, validate, commit normally
4. Push: `git push origin thread-{ts}:main` (rebase if needed)
5. Session ends: `git worktree remove`, `git branch -D thread-{ts}`
6. Container start: `git worktree prune` cleans orphans from crashes
