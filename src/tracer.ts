import { Laminar, type Span } from "@lmnr-ai/lmnr";
import { SpanStatusCode, type AttributeValue, type Attributes } from "@opentelemetry/api";
import type { LaminarConfig } from "./config.js";
import { info } from "./logger.js";
import type { Json } from "./types.js";
import { jsonDumps } from "./util.js";

// The only Laminar wire key we still write by hand — every other span field
// (type, input, session/user, metadata, path nesting) is set through the SDK.
const SPAN_OUTPUT_ATTR = "lmnr.span.output";

/**
 * Initialize the Laminar SDK once for the process. This single call replaces the
 * extension's hand-rolled OTLP pipeline AND its manual handling of:
 *   - `LMNR_SPAN_CONTEXT` (nesting under an injected upstream parent + trace_type),
 *   - the `LMNR_DEBUG` debugger/rollout session (id resolution, registration, and
 *     stamping `rollout.session_id` on every span).
 * All of that now lives in the SDK — see `Laminar.initialize`.
 *
 * `instrumentModules: {}` disables auto-instrumentation: we mint spans from pi's
 * own event stream, so we must not also patch in-process LLM libraries.
 * `forceHttp` keeps the OTLP/HTTP transport the extension has always used.
 */
export function initTracing(config: LaminarConfig): void {
  // Guard on the SDK's own state (not a local flag) so a test that pre-initializes
  // Laminar — e.g. with an in-memory exporter — makes this a no-op, and so a
  // Laminar.shutdown() correctly re-arms initialization.
  if (Laminar.initialized()) {
    return;
  }
  Laminar.initialize({
    projectApiKey: config.apiKey,
    baseUrl: config.baseUrl,
    instrumentModules: {},
    forceHttp: true,
  });
}

/** Fire-and-forget flush of pending spans. Never blocks pi, never throws. */
export function flush(): void {
  void Laminar.flush().catch((e: unknown) => info(`flush error (swallowed): ${e}`));
}

/** Convert loosely-typed attributes to OTel attributes, dropping unsupported values. */
function toOtelAttributes(attrs: Record<string, Json>): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.filter((x) => x !== null && x !== undefined) as AttributeValue;
    }
    // Objects and other types are unsupported as attribute values — drop them.
  }
  return out;
}

export interface StartSpanArgs {
  name: string;
  parent: SpanHandle | null;
  startTime: Date | null;
  spanType?: "DEFAULT" | "LLM" | "TOOL";
  inputValue?: Json;
  sessionId?: string;
  userId?: string;
  metadata?: Record<string, Json>;
  attributes?: Record<string, Json>;
}

/**
 * Mint a Laminar span from a pi event. The parent is threaded through the SDK's
 * `LaminarSpanContext` (not OTel's active context) so children nest correctly in
 * the Laminar UI regardless of which async callback creates them.
 */
export function startSpan(args: StartSpanArgs): SpanHandle {
  const startTime = args.startTime ?? new Date();
  const parentSpanContext = args.parent
    ? Laminar.getLaminarSpanContext(args.parent.span) ?? undefined
    : undefined;
  const span = Laminar.startSpan({
    name: args.name,
    spanType: args.spanType ?? "DEFAULT",
    startTime,
    ...(args.inputValue !== undefined && args.inputValue !== null
      ? { input: jsonDumps(args.inputValue) }
      : {}),
    ...(parentSpanContext ? { parentSpanContext } : {}),
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    ...(args.userId ? { userId: args.userId } : {}),
    ...(args.metadata ? { metadata: args.metadata } : {}),
  });
  const handle = new SpanHandle(span, startTime);
  if (args.attributes) {
    handle.setAttributes(args.attributes);
  }
  return handle;
}

/** A thin wrapper over a live Laminar `Span` with pi-friendly setters. */
export class SpanHandle {
  readonly span: Span;
  private readonly startTime: Date;
  private ended = false;

  constructor(span: Span, startTime: Date) {
    this.span = span;
    this.startTime = startTime;
  }

  get traceId(): string {
    return this.span.spanContext().traceId;
  }

  get spanId(): string {
    return this.span.spanContext().spanId;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  setAttributes(attributes: Record<string, Json>): void {
    this.span.setAttributes(toOtelAttributes(attributes));
  }

  /** JSON-serialize and store as the span's output. */
  setOutput(value: Json): void {
    this.span.setAttribute(SPAN_OUTPUT_ATTR, jsonDumps(value));
  }

  /** Mark the span errored (e.g. a tool result with isError). */
  setError(message?: string): void {
    this.span.setStatus({ code: SpanStatusCode.ERROR, message });
  }

  end(endTime: Date | null): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    let end = endTime ?? this.startTime;
    if (end.getTime() < this.startTime.getTime()) {
      end = this.startTime;
    }
    this.span.end(end);
  }
}
