import { buildLlmAttributes, buildRootAssociation } from "./attributes.js";
import { getLaminarConfig } from "./config.js";
import { debug, info } from "./logger.js";
import {
  exportWithTimeout,
  SPAN_OUTPUT_ATTR,
  SpanHandle,
  startSpan,
  TraceEmitter,
} from "./tracer.js";
import type { Json, PiAssistantMessage } from "./types.js";
import { extractText, jsonDumpsTruncated, parseTimestamp } from "./util.js";

// ----------------- Minimal structural pi types -----------------
// The extension is loaded BY pi, which supplies these objects. We type them
// structurally (rather than importing pi) so the extension builds standalone.
interface PiApi {
  on(event: string, handler: (event: any, ctx: PiContext) => unknown): void;
}
interface PiContext {
  sessionManager: { getSessionId(): string; getCwd?(): string };
  cwd?: string;
}

// A pi message as delivered on message_start/_end — role may be non-assistant.
interface AgentMessage extends Omit<PiAssistantMessage, "role"> {
  role: string;
}

// ----------------- Per-run state (ticket 2: bounded, dies with the run) -----------------
interface RunState {
  emitter: TraceEmitter;
  root: SpanHandle;
  llm: SpanHandle | null; // current turn's open LLM span
  tools: Map<string, SpanHandle>; // toolCallId -> open TOOL span
  turnIndex: number;
  promptMessages: Json[]; // [{role:user, content}] — input for turn 0's LLM span
  finalAssistantText: string;
}

/**
 * Laminar observability extension for pi.
 *
 * One Laminar trace per agent run (ticket 2); spans opened on start events and
 * closed on end events (fully granular, realtime); exported live over
 * OTLP/HTTP/JSON reusing the CC emitter. Fail-open throughout — a Laminar
 * problem must never break a pi turn.
 */
export default function laminar(pi: PiApi): void {
  // At most one agent run is active per session at a time; tools within a run
  // may be parallel (handled by the toolCallId-keyed map).
  let run: RunState | null = null;

  const now = (msg?: PiAssistantMessage): Date => parseTimestamp(msg?.timestamp) ?? new Date();

  /** Fire-and-forget realtime export of finished spans. Never blocks pi, never throws. */
  const flush = (emitter: TraceEmitter): void => {
    void exportWithTimeout(emitter).catch((e) => info(`flush error (swallowed): ${e}`));
  };

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
      const emitter = new TraceEmitter(config);
      const sessionId = ctx.sessionManager.getSessionId();
      const cwd = ctx.cwd ?? ctx.sessionManager.getCwd?.();
      const prompt = event.prompt ?? "";
      const root = startSpan(emitter, {
        name: "pi agent run",
        parent: null,
        startTime: new Date(),
        spanType: "DEFAULT",
        inputValue: { role: "user", content: prompt },
        attributes: buildRootAssociation(sessionId, config.userId, cwd),
      });
      run = {
        emitter,
        root,
        llm: null,
        tools: new Map(),
        turnIndex: 0,
        promptMessages: [{ role: "user", content: prompt }],
        finalAssistantText: "",
      };
      debug(`run started (session ${sessionId})`);
    } catch (e) {
      info(`before_agent_start failed (swallowed): ${e}`);
      run = null;
    }
  });

  pi.on("turn_start", (event: { turnIndex?: number }) => {
    if (run && typeof event.turnIndex === "number") {
      run.turnIndex = event.turnIndex;
    }
  });

  pi.on("message_start", (event: { message?: AgentMessage }) => {
    try {
      if (!run || !isAssistant(event.message)) {
        return;
      }
      run.llm = startSpan(run.emitter, {
        name: `LLM call (turn ${run.turnIndex})`,
        parent: run.root,
        startTime: now(event.message),
        spanType: "LLM",
      });
    } catch (e) {
      info(`message_start failed (swallowed): ${e}`);
    }
  });

  pi.on("message_end", (event: { message?: AgentMessage }) => {
    try {
      if (!run || !run.llm || !isAssistant(event.message)) {
        return;
      }
      const message = event.message;
      const inputMessages = run.turnIndex === 0 ? run.promptMessages : null;
      run.llm.setAttributes({
        ...buildLlmAttributes(message, inputMessages),
        "pi.turn.index": run.turnIndex,
      });
      run.finalAssistantText = extractText(message.content) || run.finalAssistantText;
      run.llm.end(now(message));
      run.llm = null;
      flush(run.emitter);
    } catch (e) {
      info(`message_end failed (swallowed): ${e}`);
    }
  });

  pi.on("tool_execution_start", (event: { toolCallId?: string; toolName?: string; args?: Json }) => {
    try {
      if (!run || !event.toolCallId) {
        return;
      }
      const span = startSpan(run.emitter, {
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
        span.setAttributes({ [SPAN_OUTPUT_ATTR]: jsonDumpsTruncated(event.result ?? null) });
        if (event.isError) {
          span.setError("tool reported isError");
        }
        span.end(new Date());
        run.tools.delete(event.toolCallId);
        flush(run.emitter);
      } catch (e) {
        info(`tool_execution_end failed (swallowed): ${e}`);
      }
    }
  );

  /** Close a run: set root output, sweep orphans, end root, export. */
  const finishRun = (r: RunState, reason: string): void => {
    sweepOpenSpans(r);
    r.root.setAttributes({
      [SPAN_OUTPUT_ATTR]: jsonDumpsTruncated({ role: "assistant", content: r.finalAssistantText }),
    });
    if (!r.root.isEnded) {
      r.root.end(new Date());
    }
    flush(r.emitter);
    debug(`run ended (${reason})`);
  };

  pi.on("agent_end", () => {
    try {
      if (run) {
        finishRun(run, "agent_end");
      }
    } catch (e) {
      info(`agent_end failed (swallowed): ${e}`);
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

/** Close any spans still open at run end (orphan sweep, ticket 2). */
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
