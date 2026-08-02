import assert from "node:assert/strict";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import { Laminar } from "@lmnr-ai/lmnr";
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
  status?: { code?: number };
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
    status: { code: s.status?.code },
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
function makeFakePi() {
  const handlers = new Map<string, ((e: any, ctx: any) => unknown)[]>();
  const pi = {
    on(event: string, handler: (e: any, ctx: any) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
  const ctx = {
    mode: "print",
    hasUI: false,
    cwd: "/work",
    sessionManager: { getSessionId: () => "sess-123", getCwd: () => "/work" },
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

  await emit("before_agent_start", { prompt: "list the files" });
  await emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
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

  // Regression: every turn — not just turn 0 — reports its input. Turn 1's
  // input must include the prior assistant turn and the tool result it saw.
  const llm1 = llms.find((s) => s.attrs["pi.turn.index"] === 1)!;
  assert.ok(llm1.attrs["gen_ai.input.messages"], "turn 1 LLM span carries input messages");
  assert.match(String(llm1.attrs["gen_ai.input.messages"]), /list the files/, "turn 1 input keeps the original prompt");
  assert.match(String(llm1.attrs["gen_ai.input.messages"]), /a\.txt/, "turn 1 input includes the prior tool result");

  assert.equal(tools.length, 1, "one TOOL span");
  assert.equal(tools[0].name, "bash");
  assert.match(String(tools[0].attrs["lmnr.span.input"]), /ls/);
  assert.match(String(tools[0].attrs["lmnr.span.output"]), /a\.txt/);
  assert.equal(tools[0].parentSpanId, root!.spanId, "TOOL span nests under root");
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

  const spans = capturedSpans();
  await sink.close();

  const key = "lmnr.association.properties.trace_type";
  assert.ok(spans.length >= 2, `expected spans, got ${spans.length}`);
  for (const s of spans) {
    assert.equal(s.attrs[key], "EVALUATION", `${s.name} carries trace_type=EVALUATION`);
  }
});
