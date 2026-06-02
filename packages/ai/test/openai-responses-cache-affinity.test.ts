import { afterEach, describe, expect, it, vi } from "bun:test";
import type { CachePrefixSegment } from "../src/cache-optimizer";
import { getBundledModel } from "../src/models";
import { type OpenAIResponsesOptions, streamOpenAIResponses } from "../src/providers/openai-responses";
import type { Context, Model } from "../src/types";

const originalFetch = global.fetch;
const model = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;

function createSseResponse(events: unknown[]): Response {
	const payload = `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function getHeader(headers: RequestInit["headers"], name: string): string | null {
	return new Headers(headers).get(name);
}

function countCacheOptimizerCharacters(segments: readonly CachePrefixSegment[]): number {
	return segments.reduce((total, segment) => total + segment.text.length, 0);
}

async function captureOpenAIResponseHeaders(
	options: OpenAIResponsesOptions,
): Promise<{ sessionId: string | null; clientRequestId: string | null; body: Record<string, unknown> | null }> {
	const captured = {
		sessionId: null as string | null,
		clientRequestId: null as string | null,
		body: null as Record<string, unknown> | null,
	};
	const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		captured.sessionId = getHeader(init?.headers, "session_id");
		captured.clientRequestId = getHeader(init?.headers, "x-client-request-id");
		captured.body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
		return createSseResponse([
			{
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: "Hello" },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			},
			{
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		]);
	});
	global.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect }) as typeof fetch;

	const context: Context = {
		systemPrompt: ["stable system", "stable durable context"],
		messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
	};
	const stream = streamOpenAIResponses(model, context, { apiKey: "test-key", ...options });

	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}

	return captured;
}

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("openai-responses cache affinity", () => {
	it("sets session routing headers for official OpenAI Responses requests with a sessionId", async () => {
		const captured = await captureOpenAIResponseHeaders({ sessionId: "session-123" });

		expect(captured.sessionId).toBe("session-123");
		expect(captured.clientRequestId).toBe("session-123");
		expect(captured.body?.prompt_cache_key).toBe("session-123");
	});
	it("keeps prompt cache key separate from OpenAI routing headers when both are provided", async () => {
		const captured = await captureOpenAIResponseHeaders({
			sessionId: "side-channel-456",
			promptCacheKey: "session-123",
		});

		expect(captured.sessionId).toBe("side-channel-456");
		expect(captured.clientRequestId).toBe("side-channel-456");
		expect(captured.body?.prompt_cache_key).toBe("session-123");
	});

	it("lets explicit headers override the default OpenAI session routing headers", async () => {
		const captured = await captureOpenAIResponseHeaders({
			sessionId: "session-123",
			headers: {
				session_id: "override-session",
				"x-client-request-id": "override-request",
			},
		});

		expect(captured.sessionId).toBe("override-session");
		expect(captured.clientRequestId).toBe("override-request");
		expect(captured.body?.prompt_cache_key).toBe("session-123");
	});

	it("merges adapter extra body fields into the Responses request payload", async () => {
		const captured = await captureOpenAIResponseHeaders({
			sessionId: "session-123",
			extraBody: {
				prompt_cache_key: "adapter-cache-key",
				x_provider_hint: "xai",
			},
		});

		expect(captured.body?.prompt_cache_key).toBe("adapter-cache-key");
		expect(captured.body?.x_provider_hint).toBe("xai");
	});

	it("omits OpenAI session routing headers when cache retention is disabled", async () => {
		const captured = await captureOpenAIResponseHeaders({ cacheRetention: "none", sessionId: "session-123" });

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBeNull();
		expect(captured.body?.prompt_cache_key).toBeUndefined();
	});

	it("pads OpenAI Responses developer prefixes when CacheOptimizer is enabled", async () => {
		const captured = await captureOpenAIResponseHeaders({
			sessionId: "session-123",
			cacheOptimizer: {
				enabled: true,
				blockSize: 8,
				paddingText: ".",
				countTokens: countCacheOptimizerCharacters,
			},
		});
		const input = captured.body?.input as Array<{ role?: string; content?: unknown }> | undefined;
		const paddedDeveloper = input?.find(
			item =>
				item.role === "developer" && typeof item.content === "string" && item.content.startsWith("stable durable"),
		);

		expect(paddedDeveloper?.content).toBe("stable durable context.....");
	});

	it("aligns prefixes when prompt cache key arrives via extraBody and sessionId is absent", async () => {
		const captured = await captureOpenAIResponseHeaders({
			extraBody: { prompt_cache_key: "adapter-cache-key" },
			cacheOptimizer: {
				enabled: true,
				blockSize: 8,
				paddingText: ".",
				countTokens: countCacheOptimizerCharacters,
			},
		});
		const input = captured.body?.input as Array<{ role?: string; content?: unknown }> | undefined;
		const paddedDeveloper = input?.find(
			item =>
				item.role === "developer" && typeof item.content === "string" && item.content.startsWith("stable durable"),
		);

		expect(captured.body?.prompt_cache_key).toBe("adapter-cache-key");
		expect(paddedDeveloper?.content).toBe("stable durable context.....");
	});
});
