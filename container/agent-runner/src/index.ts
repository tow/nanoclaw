/**
 * NanoClaw Agent Runner — Multi-Session Multiplexer
 *
 * Runs inside a container, manages multiple concurrent Claude sessions
 * (one per Slack thread). Each session gets its own git worktree.
 *
 * Input protocol:
 *   Stdin: ContainerInit JSON (groupFolder, chatJid, assistantName, initial thread)
 *   IPC:   JSON files in /workspace/ipc/input/ with typed messages
 *
 * Output protocol:
 *   Each result wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Every output includes threadTs to identify which session produced it.
 */

import fs from 'fs';
import path from 'path';
import { execFile, execSync } from 'child_process';
import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';

// --- Types ---

interface ContainerInit {
  groupFolder: string;
  chatJid: string;
  assistantName?: string;
  isMain: boolean;
  /** First thread to process (container always starts with one). */
  initialThread: {
    threadTs: string;
    text: string;
    sessionId?: string;
  };
  // Legacy fields for backward compatibility with scheduled tasks
  prompt?: string;
  sessionId?: string;
  isScheduledTask?: boolean;
  script?: string;
  threadTs?: string;
}

interface ContainerOutput {
  type: 'result';
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  threadTs?: string;
}

interface ContainerLifecycle {
  type: 'lifecycle';
  event: 'ready' | 'session_ended';
  threadTs?: string;
  newSessionId?: string;
}

type IPCInput =
  | { type: 'new_thread'; threadTs: string; text: string; sessionId?: string }
  | { type: 'message'; threadTs: string; text: string }
  | { type: 'close_thread'; threadTs: string }
  | { type: 'shutdown' };

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

// --- Constants ---

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_POLL_MS = 500;
const REPO_DIR = '/workspace/repo';
const THREADS_DIR = '/workspace/threads';
const SESSION_IDLE_MS = 5 * 60 * 1000;   // 5 min per session
const CONTAINER_IDLE_MS = 10 * 60 * 1000; // 10 min with zero sessions
const MAX_CONCURRENT_SESSIONS = 5;
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// --- MessageStream (reused from original) ---

class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

// --- Session Management ---

interface RunningSession {
  threadTs: string;
  sessionId: string | undefined;
  stream: MessageStream;
  state: 'running' | 'idle' | 'closing';
  lastActivity: number;
  worktreePath: string;
  branchName: string;
  /** Promise that resolves when the session's query loop ends. */
  done: Promise<void>;
}

const sessions = new Map<string, RunningSession>();
const pendingThreads: Array<{ threadTs: string; text: string; sessionId?: string }> = [];
let shuttingDown = false;
let containerInit: ContainerInit;

// --- Helpers ---

function writeOutput(output: ContainerOutput | ContainerLifecycle): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// --- Git Worktree Management ---

function createWorktree(threadTs: string): { worktreePath: string; branchName: string } {
  const safeName = threadTs.replace(/[^a-zA-Z0-9.-]/g, '-');
  const branchName = `thread-${safeName}`;
  const worktreePath = path.join(THREADS_DIR, safeName);

  fs.mkdirSync(THREADS_DIR, { recursive: true });

  // Clean up if a stale worktree exists at this path
  if (fs.existsSync(worktreePath)) {
    try {
      execSync(`git -C ${REPO_DIR} worktree remove --force ${worktreePath}`, { stdio: 'ignore' });
    } catch { /* ignore */ }
    try {
      execSync(`git -C ${REPO_DIR} branch -D ${branchName}`, { stdio: 'ignore' });
    } catch { /* ignore */ }
  }

  // Fetch latest main before creating worktree
  try {
    execSync(`git -C ${REPO_DIR} fetch origin main`, { stdio: 'ignore' });
  } catch {
    log('Warning: git fetch failed, worktree will be based on local main');
  }

  execSync(
    `git -C ${REPO_DIR} worktree add -b ${branchName} ${worktreePath} origin/main`,
    { stdio: 'pipe' },
  );

  // Set upstream tracking so `git pull --rebase` works
  execSync(
    `git -C ${worktreePath} branch --set-upstream-to=origin/main`,
    { stdio: 'ignore' },
  );

  log(`Created worktree at ${worktreePath} on branch ${branchName}`);
  return { worktreePath, branchName };
}

function removeWorktree(worktreePath: string, branchName: string): void {
  try {
    execSync(`git -C ${REPO_DIR} worktree remove --force ${worktreePath}`, { stdio: 'ignore' });
  } catch (err) {
    log(`Warning: failed to remove worktree ${worktreePath}: ${err}`);
  }
  try {
    execSync(`git -C ${REPO_DIR} branch -D ${branchName}`, { stdio: 'ignore' });
  } catch { /* branch may already be gone */ }
}

function pruneWorktrees(): void {
  try {
    execSync(`git -C ${REPO_DIR} worktree prune`, { stdio: 'ignore' });
  } catch { /* ignore */ }
}

// --- Session Lifecycle ---

function startSession(threadTs: string, initialPrompt: string, sessionId?: string): void {
  if (sessions.has(threadTs)) {
    log(`Session for thread ${threadTs} already exists, sending as message`);
    sessions.get(threadTs)!.stream.push(initialPrompt);
    return;
  }

  if (sessions.size >= MAX_CONCURRENT_SESSIONS) {
    log(`At session limit (${MAX_CONCURRENT_SESSIONS}), queueing thread ${threadTs}`);
    pendingThreads.push({ threadTs, text: initialPrompt, sessionId });
    return;
  }

  const { worktreePath, branchName } = createWorktree(threadTs);
  const stream = new MessageStream();

  const session: RunningSession = {
    threadTs,
    sessionId,
    stream,
    state: 'running',
    lastActivity: Date.now(),
    worktreePath,
    branchName,
    done: Promise.resolve(),
  };

  sessions.set(threadTs, session);
  session.done = runSessionLoop(session, initialPrompt).catch(err => {
    log(`Session ${threadTs} error: ${err}`);
    writeOutput({
      type: 'result',
      status: 'error',
      result: null,
      error: String(err),
      threadTs,
      newSessionId: session.sessionId,
    });
  }).finally(() => {
    cleanupSession(threadTs);
  });
}

function cleanupSession(threadTs: string): void {
  const session = sessions.get(threadTs);
  if (!session) return;

  // Notify host that this session has ended so it can persist the session ID
  writeOutput({
    type: 'lifecycle',
    event: 'session_ended',
    threadTs,
    newSessionId: session.sessionId,
  });

  removeWorktree(session.worktreePath, session.branchName);
  sessions.delete(threadTs);
  log(`Session ${threadTs} cleaned up (${sessions.size} remaining)`);

  // Start any pending threads now that a slot is free
  if (pendingThreads.length > 0 && sessions.size < MAX_CONCURRENT_SESSIONS) {
    const next = pendingThreads.shift()!;
    log(`Starting queued thread ${next.threadTs}`);
    startSession(next.threadTs, next.text, next.sessionId);
  }
}

async function runSessionLoop(session: RunningSession, initialPrompt: string): Promise<void> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');
  const sdkEnv: Record<string, string | undefined> = { ...process.env };

  let prompt = initialPrompt;
  let resumeAt: string | undefined;

  // Load global CLAUDE.md as additional system context
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInit.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  while (!shuttingDown && session.state !== 'closing') {
    session.state = 'running';
    session.lastActivity = Date.now();
    log(`[${session.threadTs}] Starting query (session: ${session.sessionId || 'new'})`);

    const stream = new MessageStream();
    stream.push(prompt);

    let newSessionId: string | undefined;
    let lastAssistantUuid: string | undefined;
    let messageCount = 0;

    for await (const message of query({
      prompt: stream,
      options: {
        cwd: session.worktreePath,
        resume: session.sessionId,
        resumeSessionAt: resumeAt,
        systemPrompt: globalClaudeMd
          ? { type: 'preset' as const, preset: 'claude_code' as const, append: globalClaudeMd }
          : undefined,
        allowedTools: loadAllowedTools(),
        env: sdkEnv,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
        mcpServers: {
          nanoclaw: {
            command: 'node',
            args: [mcpServerPath],
            env: {
              NANOCLAW_CHAT_JID: containerInit.chatJid,
              NANOCLAW_GROUP_FOLDER: containerInit.groupFolder,
              NANOCLAW_IS_MAIN: containerInit.isMain ? '1' : '0',
            },
          },
        },
        hooks: {
          PreCompact: [{ hooks: [createPreCompactHook(containerInit.assistantName)] }],
        },
      }
    })) {
      messageCount++;
      session.lastActivity = Date.now();

      if (message.type === 'assistant' && 'uuid' in message) {
        lastAssistantUuid = (message as { uuid: string }).uuid;
      }

      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
        session.sessionId = newSessionId;
        log(`[${session.threadTs}] Session initialized: ${newSessionId}`);
      }

      if (message.type === 'result') {
        const textResult = 'result' in message ? (message as { result?: string }).result : null;
        log(`[${session.threadTs}] Result: ${textResult ? textResult.slice(0, 200) : '(empty)'}`);
        writeOutput({
          type: 'result',
          status: 'success',
          result: textResult || null,
          newSessionId: session.sessionId,
          threadTs: session.threadTs,
        });
      }
    }

    if (newSessionId) session.sessionId = newSessionId;
    if (lastAssistantUuid) resumeAt = lastAssistantUuid;

    log(`[${session.threadTs}] Query done (${messageCount} messages)`);

    if (shuttingDown || session.state === 'closing') break;

    // Wait for next message from the session's stream
    session.state = 'idle';
    session.lastActivity = Date.now();

    const nextMessage = await waitForSessionMessage(session);
    if (nextMessage === null) break;
    prompt = nextMessage;
  }
}

/**
 * Wait for the next message pushed into this session's stream.
 * Returns null if the session is closed or shutdown requested.
 */
function waitForSessionMessage(session: RunningSession): Promise<string | null> {
  return new Promise(resolve => {
    // Check if there's already a message queued
    const checkStream = async () => {
      for await (const msg of session.stream) {
        resolve(msg.message.content as string);
        return;
      }
      // Stream ended
      resolve(null);
    };

    // The stream will yield when a message is pushed or end() is called
    checkStream();
  });
}

// --- IPC Polling ---

function drainIpcInput(): IPCInput[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: IPCInput[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        messages.push(data as IPCInput);
      } catch (err) {
        log(`Failed to process IPC file ${file}: ${err}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err}`);
    return [];
  }
}

function dispatchIPC(msg: IPCInput): void {
  switch (msg.type) {
    case 'new_thread':
      startSession(msg.threadTs, msg.text, msg.sessionId);
      break;

    case 'message': {
      const session = sessions.get(msg.threadTs);
      if (session) {
        log(`[${msg.threadTs}] Received follow-up message (${msg.text.length} chars)`);
        session.stream.push(msg.text);
        session.lastActivity = Date.now();
      } else {
        log(`[${msg.threadTs}] No active session, starting new one`);
        startSession(msg.threadTs, msg.text);
      }
      break;
    }

    case 'close_thread': {
      const session = sessions.get(msg.threadTs);
      if (session) {
        log(`[${msg.threadTs}] Close requested`);
        session.state = 'closing';
        session.stream.end();
      }
      break;
    }

    case 'shutdown':
      log('Shutdown requested');
      shuttingDown = true;
      for (const [threadTs, session] of sessions) {
        log(`[${threadTs}] Closing for shutdown`);
        session.state = 'closing';
        session.stream.end();
      }
      break;
  }
}

function reapIdleSessions(): void {
  const now = Date.now();
  for (const [threadTs, session] of sessions) {
    if (session.state === 'idle' && now - session.lastActivity > SESSION_IDLE_MS) {
      log(`[${threadTs}] Idle timeout, cleaning up`);
      session.state = 'closing';
      session.stream.end();
    }
  }
}

// --- Transcript Archival (preserved from original) ---

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return {};

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);
      if (messages.length === 0) return {};

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const time = new Date();
      const name = `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, null, assistantName);
      fs.writeFileSync(filePath, markdown);
      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err}`);
    }
    return {};
  };
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch { /* skip unparseable lines */ }
  }
  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('', `Archived: ${formatDateTime(now)}`, '', '---', '');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
    const content = msg.content.length > 2000 ? msg.content.slice(0, 2000) + '...' : msg.content;
    lines.push(`**${sender}**: ${content}`, '');
  }

  return lines.join('\n');
}

// --- Script Support (for scheduled tasks) ---

// Tool allowlist — loaded from /workspace/ipc/allowed-tools.json (written by
// the host from group config, read-only to the agent). Falls back to a
// restrictive read-only set if the file doesn't exist.
function loadAllowedTools(): string[] {
  const toolsFile = '/workspace/ipc/allowed-tools.json';
  try {
    if (fs.existsSync(toolsFile)) {
      const tools = JSON.parse(fs.readFileSync(toolsFile, 'utf-8'));
      if (Array.isArray(tools) && tools.every(t => typeof t === 'string')) {
        log(`Loaded ${tools.length} allowed tools from ${toolsFile}`);
        return tools;
      }
    }
  } catch (err) {
    log(`Warning: failed to load ${toolsFile}: ${err}`);
  }
  log('No allowed-tools.json found, using restrictive defaults (read-only)');
  return [
    'Read', 'Glob', 'Grep',
    'WebSearch', 'WebFetch',
    'ToolSearch',
    'mcp__nanoclaw__*',
  ];
}

const SCRIPT_TIMEOUT_MS = 30_000;

async function runScript(script: string): Promise<{ wakeAgent: boolean; data?: unknown } | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile('bash', [scriptPath], {
      timeout: SCRIPT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: process.env,
    }, (error, stdout, stderr) => {
      if (stderr) log(`Script stderr: ${stderr.slice(0, 500)}`);
      if (error) {
        log(`Script error: ${error.message}`);
        return resolve(null);
      }
      const lines = stdout.trim().split('\n');
      const lastLine = lines[lines.length - 1];
      if (!lastLine) return resolve(null);
      try {
        const result = JSON.parse(lastLine);
        if (typeof result.wakeAgent !== 'boolean') return resolve(null);
        resolve(result);
      } catch {
        resolve(null);
      }
    });
  });
}

// --- Main ---

async function main(): Promise<void> {
  try {
    const stdinData = await readStdin();
    containerInit = JSON.parse(stdinData);
    log(`Received init for group: ${containerInit.groupFolder}`);
  } catch (err) {
    writeOutput({ type: 'result', status: 'error', result: null, error: `Failed to parse input: ${err}` });
    process.exit(1);
  }

  // Clean up stale IPC files and worktrees from previous runs
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  pruneWorktrees();

  // Handle legacy single-session mode (scheduled tasks)
  if (containerInit.isScheduledTask) {
    await runLegacySingleSession();
    return;
  }

  // Determine initial thread — support both new format and legacy
  const initialThread = containerInit.initialThread || {
    threadTs: containerInit.threadTs || '_default',
    text: containerInit.prompt || '',
    sessionId: containerInit.sessionId,
  };

  // Signal readiness
  writeOutput({ type: 'lifecycle', event: 'ready' });

  // Start first session
  startSession(initialThread.threadTs, initialThread.text, initialThread.sessionId);

  // Main IPC poll loop
  let lastSessionActivity = Date.now();
  const idleCheckInterval = setInterval(() => reapIdleSessions(), 30_000);

  while (!shuttingDown) {
    const messages = drainIpcInput();
    for (const msg of messages) {
      dispatchIPC(msg);
    }

    // Track container-level idle (zero sessions)
    if (sessions.size > 0) {
      lastSessionActivity = Date.now();
    } else if (Date.now() - lastSessionActivity > CONTAINER_IDLE_MS) {
      log('No active sessions for 10 min, self-exiting');
      break;
    }

    await new Promise(r => setTimeout(r, IPC_POLL_MS));
  }

  clearInterval(idleCheckInterval);

  // Wait for all sessions to finish
  log(`Waiting for ${sessions.size} sessions to close...`);
  const sessionDones = [...sessions.values()].map(s => s.done);
  await Promise.allSettled(sessionDones);

  // Final cleanup
  pruneWorktrees();
  log('Container exiting');
}

/**
 * Legacy mode for scheduled tasks — single session, no worktrees,
 * works like the original agent runner.
 */
async function runLegacySingleSession(): Promise<void> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');
  const sdkEnv: Record<string, string | undefined> = { ...process.env };

  let prompt = containerInit.prompt || '';
  const sessionId = containerInit.sessionId;

  if (containerInit.isScheduledTask) {
    prompt = `[SCHEDULED TASK]\n\n${prompt}`;
  }

  if (containerInit.script && containerInit.isScheduledTask) {
    log('Running task script...');
    const scriptResult = await runScript(containerInit.script);
    if (!scriptResult || !scriptResult.wakeAgent) {
      writeOutput({ type: 'result', status: 'success', result: null });
      return;
    }
    prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${containerInit.prompt}`;
  }

  const stream = new MessageStream();
  stream.push(prompt);
  stream.end();

  let newSessionId: string | undefined;
  for await (const message of query({
    prompt: stream,
    options: {
      cwd: '/workspace/group',
      resume: sessionId,
      allowedTools: loadAllowedTools(),
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInit.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInit.groupFolder,
            NANOCLAW_IS_MAIN: containerInit.isMain ? '1' : '0',
          },
        },
      },
    }
  })) {
    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
    }
    if (message.type === 'result') {
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      writeOutput({ type: 'result', status: 'success', result: textResult || null, newSessionId });
    }
  }
}

main();
