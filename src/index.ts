import { buildLlmAttributes, buildToolDefinitions } from "./attributes.js";
import { getLaminarConfig } from "./config.js";
import { debug, info } from "./logger.js";
import { systemMessage, toChatMessages } from "./messages.js";
import { flush, initTracing, SpanHandle, startSpan } from "./tracer.js";
import { FAILED_STOP_REASONS, type Json, type PiAssistantMessage, type PiToolInfo } from "./types.js";
import { extractText, jsonDumps } from "./util.js";

// ----------------- Minimal structural pi types -----------------
// The extension is loaded BY pi, which supplies these objects. We type them
// structurally (rather than importing pi) so the extension builds standalone.
interface PiApi {
  on(event: string, handler: (event: any, ctx: PiContext) => unknown): void;
  /** Every configured tool, with its JSON-schema parameters. */
  getAllTools?(): PiToolInfo[];
  /** Names of the tools active for the current run. */
  getActiveTools?(): string[];
}
interface PiContext {
  sessionManager: { getSessionId(): string; getCwd?(): string };
  cwd?: string;
  /** pi's effective system prompt for the current run. */
  getSystemPrompt?(): string;
}

// A pi message as delivered on message_start/_end — role may be non-assistant.
interface AgentMessage extends Omit<PiAssistantMessage, "role"> {
  role: string;
}

// ----------------- Per-run state (bounded, dies with the run) -----------------
interface RunState {
  root: SpanHandle;
  llm: SpanHandle | null; // current turn's open LLM span
  tools: Map<string, SpanHandle>; // toolCallId -> open TOOL span
  turnIndex: number; // pi's own turn index, which restarts at 0 each agent pass
  llmCount: number; // monotonic across passes, so span names stay unique
  failure: string | null; // set when a turn ends in error/aborted
  // The run's effective system prompt, and the tools it was built with — both
  // fixed for the run and both resolved at agent_start. The system prompt heads
  // every turn's input; the tool definitions ride every LLM span.
  systemPrompt: string;
  toolDefinitions: string | null; // serialized, ready to set as an attribute
  // The messages pi is about to send, captured from the `context` event before
  // each LLM call. pi assembles this list itself — full session history and
  // post-compaction state included — so we report it rather than reconstruct it.
  pendingInput: Json[] | null;
  finalAssistantText: string;
}

/**
 * Laminar observability extension for pi.
 *
 * One Laminar trace per agent run; spans opened on start events and closed on
 * end events (fully granular, realtime). Tracing, OTLP export, LMNR_SPAN_CONTEXT
 * nesting, and the LMNR_DEBUG debugger/rollout session are all delegated to the
 * `@lmnr-ai/lmnr` SDK. Fail-open throughout — a Laminar problem must never break
 * a pi turn.
 */
export default function laminar(pi: PiApi): void {
  // At most one agent run is active per session at a time; tools within a run
  // may be parallel (handled by the toolCallId-keyed map).
  let run: RunState | null = null;

  // Span times come from the wall clock at the moment the event fires. pi's
  // message `timestamp` is the message's creation time, not its completion time,
  // so it is not an end time — and it arrives as a number, which the old
  // string-only parse silently rejected, meaning this was always the real path.
  const isAssistant = (m: AgentMessage | undefined): m is PiAssistantMessage =>
    !!m && m.role === "assistant";

  pi.on("before_agent_start", (event: { prompt?: string }, ctx: PiContext) => {
    try {
      const config = getLaminarConfig();
      if (!config) {
        debug("no LMNR_PROJECT_API_KEY — tracing disabled (fail-open)");
        run = null;
        return;
      }
      // Idempotent: initializes the SDK once for the process. The SDK reads
      // LMNR_SPAN_CONTEXT (upstream parent + trace_type) and LMNR_DEBUG (debugger
      // rollout session) from the environment on its own — the extension no
      // longer resolves, registers, or stamps any of that itself.
      initTracing(config);
      const sessionId = ctx.sessionManager.getSessionId();
      const cwd = ctx.cwd ?? ctx.sessionManager.getCwd?.();
      const prompt = event.prompt ?? "";
      const root = startSpan({
        name: "pi agent run",
        parent: null,
        startTime: new Date(),
        spanType: "DEFAULT",
        inputValue: { role: "user", content: prompt },
        sessionId,
        ...(config.userId ? { userId: config.userId } : {}),
        metadata: { source: "pi", ...(cwd ? { cwd } : {}) },
      });
      run = {
        root,
        llm: null,
        tools: new Map(),
        turnIndex: 0,
        llmCount: 0,
        failure: null,
        systemPrompt: "",
        toolDefinitions: null,
        pendingInput: null,
        finalAssistantText: "",
      };
      debug(`run started (session ${sessionId})`);
    } catch (e) {
      info(`before_agent_start failed (swallowed): ${e}`);
      run = null;
    }
  });

  /** The tools active for this run, serialized for `gen_ai.tool.definitions`. */
  const snapshotToolDefinitions = (): string | null => {
    const all = pi.getAllTools?.();
    if (!all?.length) {
      return null;
    }
    const active = new Set(pi.getActiveTools?.() ?? all.map((t) => t.name));
    const definitions = buildToolDefinitions(all.filter((t) => active.has(t.name)));
    return definitions.length > 0 ? jsonDumps(definitions) : null;
  };

  // pi chains the system prompt through every `before_agent_start` handler, so
  // the value ours sees there is not necessarily the one that gets sent. By
  // `agent_start` the chain has settled and `ctx.getSystemPrompt()` returns the
  // effective prompt. Both it and the active tool set stay fixed for the run.
  pi.on("agent_start", (_event: unknown, ctx: PiContext) => {
    try {
      if (run) {
        run.systemPrompt = ctx.getSystemPrompt?.() ?? "";
        run.toolDefinitions = snapshotToolDefinitions();
      }
    } catch (e) {
      info(`agent_start failed (swallowed): ${e}`);
    }
  });

  // pi assembles the outgoing message list itself and hands it over before every
  // LLM call — full session history, compaction already applied, extension-
  // injected messages included. Reporting this beats reconstructing it from the
  // event stream, which silently omitted everything before the current prompt.
  pi.on("context", (event: { messages?: Json[] }) => {
    try {
      if (!run) {
        return;
      }
      const conversation = toChatMessages(event.messages ?? []);
      run.pendingInput = run.systemPrompt
        ? [systemMessage(run.systemPrompt), ...conversation]
        : conversation;
      // This event is pi's "about to call the model", so it is where the LLM span
      // opens. `message_start` does not fire until the response is already coming
      // back, which left the provider latency — around 95% of the call — outside
      // the span, and made every LLM duration in the trace meaningless.
      if (run.llm && !run.llm.isEnded) {
        // A previous call never reached message_end (aborted mid-flight).
        run.llm.end(new Date());
      }
      run.llm = startSpan({
        // Named from our own counter, not pi's turn index: pi restarts that at 0
        // on every agent pass, so a run with a retry or continuation would
        // otherwise carry two spans both called "turn 0".
        name: `LLM call (turn ${run.llmCount})`,
        parent: run.root,
        startTime: new Date(),
        spanType: "LLM",
      });
      run.llmCount += 1;
    } catch (e) {
      info(`context failed (swallowed): ${e}`);
    }
  });

  pi.on("turn_start", (event: { turnIndex?: number }) => {
    if (run && typeof event.turnIndex === "number") {
      run.turnIndex = event.turnIndex;
    }
  });

  pi.on("message_end", (event: { message?: AgentMessage }) => {
    try {
      if (!run || !run.llm || !isAssistant(event.message)) {
        return;
      }
      const message = event.message;
      run.llm.setAttributes({
        ...buildLlmAttributes(message, run.pendingInput),
        "pi.turn.index": run.turnIndex,
        ...(run.toolDefinitions ? { "gen_ai.tool.definitions": run.toolDefinitions } : {}),
      });
      run.pendingInput = null;
      run.finalAssistantText = extractText(message.content) || run.finalAssistantText;
      // A turn that errored or was aborted marks its span — and the run — failed.
      // pi retries some of these, so the run's verdict is whatever the last turn
      // reported: a successful retry clears it.
      if (message.stopReason && FAILED_STOP_REASONS.has(message.stopReason)) {
        run.failure = message.errorMessage ?? message.stopReason;
        run.llm.setError(run.failure);
      } else {
        run.failure = null;
      }
      run.llm.end(new Date());
      run.llm = null;
      flush();
    } catch (e) {
      info(`message_end failed (swallowed): ${e}`);
    }
  });

  pi.on("tool_execution_start", (event: { toolCallId?: string; toolName?: string; args?: Json }) => {
    try {
      if (!run || !event.toolCallId) {
        return;
      }
      const span = startSpan({
        name: event.toolName ?? "tool",
        parent: run.root,
        startTime: new Date(),
        spanType: "TOOL",
        inputValue: event.args ?? null,
        attributes: {
          "gen_ai.tool.name": event.toolName ?? "",
          "gen_ai.tool.call.id": event.toolCallId,
          "pi.turn.index": run.turnIndex,
        },
      });
      run.tools.set(event.toolCallId, span);
    } catch (e) {
      info(`tool_execution_start failed (swallowed): ${e}`);
    }
  });

  pi.on(
    "tool_execution_end",
    (event: { toolCallId?: string; result?: Json; isError?: boolean }) => {
      try {
        if (!run || !event.toolCallId) {
          return;
        }
        const span = run.tools.get(event.toolCallId);
        if (!span) {
          return;
        }
        span.setOutput(event.result ?? null);
        if (event.isError) {
          span.setError("tool reported isError");
        }
        span.end(new Date());
        run.tools.delete(event.toolCallId);
        flush();
      } catch (e) {
        info(`tool_execution_end failed (swallowed): ${e}`);
      }
    }
  );

  /** Close a run: set root output, sweep orphans, end root, export. */
  const finishRun = (r: RunState, reason: string): void => {
    sweepOpenSpans(r);
    r.root.setOutput({ role: "assistant", content: r.finalAssistantText });
    if (r.failure) {
      r.root.setError(r.failure);
    }
    if (!r.root.isEnded) {
      r.root.end(new Date());
    }
    flush();
    debug(`run ended (${reason})`);
  };

  // `agent_end` ends one pass of the agent loop — NOT the run. pi drives
  // `while (await handlePostAgentRun()) await agent.continue()`, so an auto-retry,
  // an auto-compaction retry, or a queued follow-up starts another
  // agent_start…agent_end pass under the same user prompt, with no second
  // before_agent_start. `agent_settled` fires once, from a `finally`, when pi has
  // decided not to continue — that is the run boundary. Closing on agent_end
  // instead dropped every span of every continuation on the floor.
  pi.on("agent_settled", () => {
    try {
      if (run) {
        finishRun(run, "agent_settled");
      }
    } catch (e) {
      info(`agent_settled failed (swallowed): ${e}`);
    } finally {
      run = null;
    }
  });

  // Safety net: a crash/replacement mid-run must not leak open spans.
  pi.on("session_shutdown", () => {
    try {
      if (run) {
        finishRun(run, "session_shutdown");
      }
    } catch (e) {
      info(`session_shutdown failed (swallowed): ${e}`);
    } finally {
      run = null;
    }
  });
}

/** Close any spans still open at run end (orphan sweep). */
function sweepOpenSpans(run: RunState): void {
  const end = new Date();
  if (run.llm && !run.llm.isEnded) {
    run.llm.end(end);
  }
  run.llm = null;
  for (const span of run.tools.values()) {
    if (!span.isEnded) {
      span.end(end);
    }
  }
  run.tools.clear();
}
