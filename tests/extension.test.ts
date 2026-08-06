import assert from "node:assert/strict";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import { Laminar } from "@lmnr-ai/lmnr";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

// ---- Span capture: read finished spans straight out of the SDK ----
// The extension now delegates OTLP export to the SDK, so the test injects an
// in-memory exporter via `spanProcessor` instead of standing up an OTLP sink.
// The extension's `initTracing` sees Laminar already initialized and no-ops, so
// this exercises the real span-construction path end to end.
interface CapturedSpan {
  name: string;
  spanId: string;
  parentSpanId?: string;
  status?: { code?: number; message?: string };
  attrs: Record<string, unknown>;
}

function toCaptured(s: ReadableSpan): CapturedSpan {
  const parentSpanId =
    (s as { parentSpanContext?: { spanId?: string } }).parentSpanContext?.spanId ??
    (s as { parentSpanId?: string }).parentSpanId ??
    undefined;
  return {
    name: s.name,
    spanId: s.spanContext().spanId,
    parentSpanId,
    status: { code: s.status?.code, message: s.status?.message },
    attrs: { ...s.attributes },
  };
}

const exporter = new InMemorySpanExporter();

function initSdk(): void {
  Laminar.initialize({
    projectApiKey: "sk-test",
    baseUrl: process.env.LMNR_BASE_URL,
    spanProcessor: new SimpleSpanProcessor(exporter),
    instrumentModules: {},
  });
}

function capturedSpans(): CapturedSpan[] {
  return exporter.getFinishedSpans().map(toCaptured);
}

// Black-hole sink: the SDK's debug-mode rollout registration fire-and-forgets a
// POST; give it a local 200 so no test touches the real API.
async function startSink(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

afterEach(async () => {
  await Laminar.shutdown();
  exporter.reset();
  for (const k of [
    "LMNR_PROJECT_API_KEY",
    "LMNR_BASE_URL",
    "LMNR_DEBUG",
    "LMNR_DEBUG_SESSION_ID",
    "LMNR_SPAN_CONTEXT",
  ]) {
    delete process.env[k];
  }
});

// ---- Fake pi API ----
const SYSTEM_PROMPT = "You are an expert coding assistant operating inside pi.";
const ALL_TOOLS = [
  { name: "bash", description: "Execute a command", parameters: { type: "object" } },
  { name: "read", description: "Read file contents", parameters: { type: "object" } },
  { name: "disabled", description: "Not active this run", parameters: { type: "object" } },
];

function makeFakePi() {
  const handlers = new Map<string, ((e: any, ctx: any) => unknown)[]>();
  const pi = {
    on(event: string, handler: (e: any, ctx: any) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    getAllTools: () => ALL_TOOLS,
    getActiveTools: () => ["bash", "read"],
  };
  const ctx = {
    mode: "print",
    hasUI: false,
    cwd: "/work",
    sessionManager: { getSessionId: () => "sess-123", getCwd: () => "/work" },
    getSystemPrompt: () => SYSTEM_PROMPT,
  };
  const emit = async (event: string, payload: any) => {
    for (const h of handlers.get(event) ?? []) {
      await h({ type: event, ...payload }, ctx);
    }
  };
  return { pi, emit };
}

const asstStart = { message: { role: "assistant", content: [], model: "us.anthropic.claude-opus-4-8", provider: "amazon-bedrock" } };

test("end-to-end: pi event stream produces the expected Laminar span tree", async () => {
  const sink = await startSink();
  process.env.LMNR_PROJECT_API_KEY = "sk-test";
  process.env.LMNR_BASE_URL = sink.url;
  initSdk();

  const { default: laminar } = await import("../src/index.js");
  const { pi, emit } = makeFakePi();
  laminar(pi);

  // pi hands us the outgoing message list on `context` before each LLM call, in
  // its own shape: role `toolResult`, `{type: "toolCall"}` content blocks.
  const userMsg = { role: "user", content: [{ type: "text", text: "list the files" }] };
  const asstMsg = {
    role: "assistant",
    content: [
      { type: "text", text: "I'll list them." },
      { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } },
    ],
  };
  const toolMsg = {
    role: "toolResult",
    toolCallId: "tc1",
    toolName: "bash",
    content: [{ type: "text", text: "a.txt\nb.txt" }],
    isError: false,
  };

  await emit("before_agent_start", { prompt: "list the files" });
  await emit("agent_start", {});
  await emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
  await emit("context", { messages: [userMsg] });
  await emit("message_start", asstStart);
  await emit("message_end", {
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "I'll list them." },
        { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } },
      ],
      api: "bedrock-converse-stream",
      provider: "amazon-bedrock",
      model: "us.anthropic.claude-opus-4-8",
      stopReason: "toolUse",
      usage: { input: 2, output: 89, cacheRead: 0, cacheWrite: 8209, totalTokens: 8300, cost: { total: 0.0535 } },
    },
  });
  await emit("tool_execution_start", { toolCallId: "tc1", toolName: "bash", args: { command: "ls" } });
  await emit("tool_execution_end", { toolCallId: "tc1", toolName: "bash", result: "a.txt\nb.txt", isError: false });
  await emit("turn_start", { turnIndex: 1, timestamp: Date.now() });
  await emit("context", { messages: [userMsg, asstMsg, toolMsg] });
  await emit("message_start", asstStart);
  await emit("message_end", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Done — 2 files." }],
      provider: "amazon-bedrock",
      model: "us.anthropic.claude-opus-4-8",
      stopReason: "endTurn",
      usage: { input: 10, output: 20, totalTokens: 30, cost: { total: 0.001 } },
    },
  });
  await emit("agent_end", { messages: [] });
  await emit("agent_settled", {});

  const spans = capturedSpans();
  await sink.close();

  assert.equal(spans.length, 4, `expected 4 spans, got ${spans.length}`);

  const root = spans.find((s) => s.attrs["lmnr.span.type"] === "DEFAULT");
  const llms = spans.filter((s) => s.attrs["lmnr.span.type"] === "LLM");
  const tools = spans.filter((s) => s.attrs["lmnr.span.type"] === "TOOL");

  assert.ok(root, "has a DEFAULT root span");
  assert.equal(root!.name, "pi agent run");
  assert.equal(root!.attrs["lmnr.association.properties.session_id"], "sess-123");
  assert.match(String(root!.attrs["lmnr.span.input"]), /list the files/);
  assert.match(String(root!.attrs["lmnr.span.output"]), /Done — 2 files/);

  assert.equal(llms.length, 2, "two LLM spans (one per turn)");
  const llm0 = llms.find((s) => s.attrs["pi.turn.index"] === 0)!;
  assert.equal(llm0.attrs["gen_ai.system"], "anthropic");
  assert.equal(llm0.attrs["gen_ai.provider.name"], "amazon-bedrock");
  assert.equal(llm0.attrs["gen_ai.usage.input_tokens"], 2);
  assert.equal(llm0.attrs["llm.usage.total_tokens"], 8300);
  assert.equal(llm0.attrs["gen_ai.usage.cost"], 0.0535);
  assert.equal(llm0.parentSpanId, root!.spanId, "LLM span nests under root");
  assert.match(String(llm0.attrs["gen_ai.input.messages"]), /list the files/, "turn 0 input is the user prompt");

  // The system prompt heads every turn's input, as the provider received it.
  for (const llm of llms) {
    const input = JSON.parse(String(llm.attrs["gen_ai.input.messages"]));
    assert.deepEqual(
      input[0],
      { role: "system", content: [{ type: "text", text: SYSTEM_PROMPT }] },
      `turn ${llm.attrs["pi.turn.index"]} input opens with the system prompt`
    );
  }

  // Tool definitions ride every LLM span (the only span type Laminar reads them
  // off), filtered to the run's active set.
  for (const llm of llms) {
    const tools = JSON.parse(String(llm.attrs["gen_ai.tool.definitions"]));
    assert.deepEqual(
      tools.map((t: { name: string }) => t.name),
      ["bash", "read"],
      "inactive tools are excluded"
    );
    assert.equal(tools[0].description, "Execute a command");
  }

  // Regression: every turn — not just turn 0 — reports its input. Turn 1's
  // input must include the prior assistant turn and the tool result it saw,
  // mapped out of pi's shape into GenAI parts.
  const llm1 = llms.find((s) => s.attrs["pi.turn.index"] === 1)!;
  const input1 = JSON.parse(String(llm1.attrs["gen_ai.input.messages"]));
  assert.deepEqual(
    input1.map((m: { role: string }) => m.role),
    // Anthropic carries tool results on a user message, so the tool turn is "user".
    ["system", "user", "assistant", "user"],
    "turn 1 input carries the whole conversation pi sent"
  );
  assert.deepEqual(input1[2].content[1], {
    type: "tool_use",
    id: "tc1",
    name: "bash",
    input: { command: "ls" },
  });
  assert.deepEqual(input1[3].content[0], {
    type: "tool_result",
    tool_use_id: "tc1",
    content: [{ type: "text", text: "a.txt\nb.txt" }],
  });

  // Output messages use the same Anthropic content shape as the input.
  assert.deepEqual(JSON.parse(String(llm1.attrs["gen_ai.output.messages"])), [
    { role: "assistant", content: [{ type: "text", text: "Done — 2 files." }] },
  ]);

  assert.equal(tools.length, 1, "one TOOL span");
  assert.equal(tools[0].name, "bash");
  assert.match(String(tools[0].attrs["lmnr.span.input"]), /ls/);
  assert.match(String(tools[0].attrs["lmnr.span.output"]), /a\.txt/);
  assert.equal(tools[0].parentSpanId, root!.spanId, "TOOL span nests under root");
});

// Regression for the bug the hand-built transcript had: it was seeded fresh on
// every prompt, so the second prompt of a session reported only itself as the
// input. Sourcing from `context` reports the history pi actually sent.
test("a later prompt in the same session reports the earlier exchange as input", async () => {
  const sink = await startSink();
  process.env.LMNR_PROJECT_API_KEY = "sk-test";
  process.env.LMNR_BASE_URL = sink.url;
  initSdk();

  const { default: laminar } = await import("../src/index.js");
  const { pi, emit } = makeFakePi();
  laminar(pi);

  const say = async (prompt: string, history: unknown[], reply: string) => {
    await emit("before_agent_start", { prompt });
    await emit("agent_start", {});
    await emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
    await emit("context", { messages: [...history, { role: "user", content: [{ type: "text", text: prompt }] }] });
    await emit("message_start", asstStart);
    await emit("message_end", {
      message: {
        role: "assistant",
        content: [{ type: "text", text: reply }],
        provider: "amazon-bedrock",
        model: "us.anthropic.claude-opus-4-8",
        stopReason: "endTurn",
        usage: { input: 1, output: 1, totalTokens: 2 },
      },
    });
    await emit("agent_end", {});
  await emit("agent_settled", {});
  };

  await say("say alpha", [], "alpha");
  await say("say beta", [
    { role: "user", content: [{ type: "text", text: "say alpha" }] },
    { role: "assistant", content: [{ type: "text", text: "alpha" }] },
  ], "beta");

  const spans = capturedSpans();
  await sink.close();

  const llms = spans.filter((s) => s.attrs["lmnr.span.type"] === "LLM");
  assert.equal(llms.length, 2, "one LLM span per prompt");
  const second = JSON.parse(String(llms[1].attrs["gen_ai.input.messages"]));
  assert.deepEqual(
    second.map((m: { role: string }) => m.role),
    ["system", "user", "assistant", "user"],
    "the second prompt's input carries the first exchange"
  );
  assert.equal(second[1].content[0].text, "say alpha");
  assert.equal(second[2].content[0].text, "alpha");
});

// pi's agent loop can run several passes for ONE user prompt — auto-retry,
// auto-compaction retry, or a queued follow-up each fire another
// agent_start…agent_end pass with no second before_agent_start, and pi restarts
// its turn index at 0 each time. Closing the run on agent_end dropped every span
// after the first pass; `agent_settled` is the real boundary.
test("a continuation after agent_end stays in the same trace", async () => {
  const sink = await startSink();
  process.env.LMNR_PROJECT_API_KEY = "sk-test";
  process.env.LMNR_BASE_URL = sink.url;
  initSdk();

  const { default: laminar } = await import("../src/index.js");
  const { pi, emit } = makeFakePi();
  laminar(pi);

  const pass = async (text: string, stopReason: string) => {
    await emit("agent_start", {});
    await emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
    await emit("context", { messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] });
    await emit("message_start", asstStart);
    await emit("message_end", {
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        provider: "amazon-bedrock",
        model: "us.anthropic.claude-opus-4-8",
        stopReason,
        errorMessage: stopReason === "error" ? "provider overloaded" : undefined,
        usage: { input: 1, output: 1, totalTokens: 2 },
      },
    });
    await emit("agent_end", {});
  };

  await emit("before_agent_start", { prompt: "go" });
  await pass("", "error"); // pass 1 fails …
  await pass("recovered", "endTurn"); // … pi auto-retries, same user prompt
  await emit("agent_settled", {});

  const spans = capturedSpans();
  await sink.close();

  const root = spans.filter((s) => s.attrs["lmnr.span.type"] === "DEFAULT");
  const llms = spans.filter((s) => s.attrs["lmnr.span.type"] === "LLM");
  assert.equal(root.length, 1, "one root span for the whole user prompt");
  assert.equal(llms.length, 2, "both passes produce an LLM span");
  for (const llm of llms) {
    assert.equal(llm.parentSpanId, root[0].spanId, "every pass nests under the one root");
  }

  // pi called both passes "turn 0"; our names stay unique and its index rides along.
  assert.deepEqual(llms.map((s) => s.name).sort(), ["LLM call (turn 0)", "LLM call (turn 1)"]);
  assert.deepEqual(llms.map((s) => s.attrs["pi.turn.index"]), [0, 0]);

  // The failed pass is marked ERROR; the successful retry clears the run verdict.
  const failed = llms.find((s) => s.name === "LLM call (turn 0)")!;
  assert.equal(failed.status?.code, SpanStatusCode.ERROR, "the errored turn is marked failed");
  assert.equal(root[0].status?.code, SpanStatusCode.UNSET, "the retried run is not marked failed");
});

test("a run whose last turn errors marks the root span failed", async () => {
  const sink = await startSink();
  process.env.LMNR_PROJECT_API_KEY = "sk-test";
  process.env.LMNR_BASE_URL = sink.url;
  initSdk();

  const { default: laminar } = await import("../src/index.js");
  const { pi, emit } = makeFakePi();
  laminar(pi);

  await emit("before_agent_start", { prompt: "go" });
  await emit("agent_start", {});
  await emit("context", { messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] });
  await emit("message_start", asstStart);
  await emit("message_end", {
    message: {
      role: "assistant",
      content: [],
      provider: "amazon-bedrock",
      model: "us.anthropic.claude-opus-4-8",
      stopReason: "error",
      errorMessage: "context length exceeded",
      usage: { input: 1, output: 0, totalTokens: 1 },
    },
  });
  await emit("agent_end", {});
  await emit("agent_settled", {});

  const spans = capturedSpans();
  await sink.close();

  const root = spans.find((s) => s.attrs["lmnr.span.type"] === "DEFAULT")!;
  const llm = spans.find((s) => s.attrs["lmnr.span.type"] === "LLM")!;
  assert.equal(llm.status?.code, SpanStatusCode.ERROR);
  assert.equal(llm.status?.message, "context length exceeded", "pi's error message is kept");
  assert.equal(root.status?.code, SpanStatusCode.ERROR, "the run is marked failed");
});

// Thinking is reported as a structured Anthropic block, not concatenated into the
// answer text. Inlining it (PostHog's `[thinking]\n…`) would make reasoning
// indistinguishable from the reply for every downstream reader.
test("thinking stays a separate block in the output message", async () => {
  const sink = await startSink();
  process.env.LMNR_PROJECT_API_KEY = "sk-test";
  process.env.LMNR_BASE_URL = sink.url;
  initSdk();

  const { default: laminar } = await import("../src/index.js");
  const { pi, emit } = makeFakePi();
  laminar(pi);

  await emit("before_agent_start", { prompt: "count the files" });
  await emit("agent_start", {});
  await emit("context", { messages: [{ role: "user", content: [{ type: "text", text: "count the files" }] }] });
  await emit("message_start", asstStart);
  await emit("message_end", {
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "I should run ls first." },
        { type: "text", text: "There are 8." },
      ],
      provider: "amazon-bedrock",
      model: "us.anthropic.claude-opus-4-8",
      stopReason: "endTurn",
      usage: { input: 1, output: 1, totalTokens: 2 },
    },
  });
  await emit("agent_end", {});
  await emit("agent_settled", {});

  const spans = capturedSpans();
  await sink.close();

  const llm = spans.find((s) => s.attrs["lmnr.span.type"] === "LLM")!;
  assert.deepEqual(JSON.parse(String(llm.attrs["gen_ai.output.messages"])), [
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "I should run ls first." },
        { type: "text", text: "There are 8." },
      ],
    },
  ]);

  // The run's summary output is the reply only — reasoning is not the answer.
  const root = spans.find((s) => s.attrs["lmnr.span.type"] === "DEFAULT")!;
  assert.deepEqual(JSON.parse(String(root.attrs["lmnr.span.output"])), {
    role: "assistant",
    content: "There are 8.",
  });
});

test("debugger mode stamps rollout.session_id on every span", async () => {
  const sink = await startSink();
  process.env.LMNR_PROJECT_API_KEY = "sk-test";
  process.env.LMNR_BASE_URL = sink.url;
  process.env.LMNR_DEBUG = "true";
  process.env.LMNR_DEBUG_SESSION_ID = "rollout-xyz";
  initSdk();

  const { default: laminar } = await import("../src/index.js");
  const { pi, emit } = makeFakePi();
  laminar(pi);

  await emit("before_agent_start", { prompt: "hi" });
  await emit("agent_start", {});
  await emit("context", { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
  await emit("message_start", asstStart);
  await emit("message_end", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      provider: "amazon-bedrock",
      model: "us.anthropic.claude-opus-4-8",
      stopReason: "endTurn",
      usage: { input: 1, output: 1, totalTokens: 2 },
    },
  });
  await emit("agent_end", {});
  await emit("agent_settled", {});

  const spans = capturedSpans();
  await sink.close();

  const key = "lmnr.association.properties.metadata.rollout.session_id";
  assert.ok(spans.length >= 2, `expected spans, got ${spans.length}`);
  for (const s of spans) {
    assert.equal(s.attrs[key], "rollout-xyz", `${s.name} carries the rollout session id`);
  }
});

test("injected LMNR_SPAN_CONTEXT propagates trace_type onto every span", async () => {
  const sink = await startSink();
  process.env.LMNR_PROJECT_API_KEY = "sk-test";
  process.env.LMNR_BASE_URL = sink.url;
  // Mirrors what Harbor injects for an eval trial: trace_type travels in the
  // same JSON as the ids (LaminarSpanContext.model_dump_json).
  process.env.LMNR_SPAN_CONTEXT = JSON.stringify({
    trace_id: "3dbfd1ba-ff43-9db7-b08f-6796af502e35",
    span_id: "00000000-0000-0000-1234-567890abcdef",
    is_remote: true,
    trace_type: "EVALUATION",
  });
  initSdk();

  const { default: laminar } = await import("../src/index.js");
  const { pi, emit } = makeFakePi();
  laminar(pi);

  await emit("before_agent_start", { prompt: "hi" });
  await emit("agent_start", {});
  await emit("context", { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
  await emit("message_start", asstStart);
  await emit("message_end", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      provider: "amazon-bedrock",
      model: "us.anthropic.claude-opus-4-8",
      stopReason: "endTurn",
      usage: { input: 1, output: 1, totalTokens: 2 },
    },
  });
  await emit("agent_end", {});
  await emit("agent_settled", {});

  const spans = capturedSpans();
  await sink.close();

  const key = "lmnr.association.properties.trace_type";
  assert.ok(spans.length >= 2, `expected spans, got ${spans.length}`);
  for (const s of spans) {
    assert.equal(s.attrs[key], "EVALUATION", `${s.name} carries trace_type=EVALUATION`);
  }
});
