/**
 * MCP stdio transport.
 *
 * Implements JSON-RPC 2.0 over subprocess stdin/stdout.
 * Messages are newline-delimited JSON.
 */

import { getProjectDir, readJsonl, Snowflake } from "@oh-my-pi/pi-utils";
import { type Subprocess, spawn } from "bun";
import type {
	JsonRpcError,
	JsonRpcMessage,
	JsonRpcRequest,
	JsonRpcResponse,
	MCPRequestOptions,
	MCPStdioServerConfig,
	MCPTransport,
} from "../../mcp/types";
import { toJsonRpcError } from "../../mcp/types";
import { isMCPTimeoutEnabled, resolveMCPTimeoutMs } from "../timeout";

/** Minimal write surface of `Subprocess.stdin` we need for framed sends. */
interface FrameSink {
	write(chunk: string): unknown;
	flush(): unknown;
}

/**
 * Attach a no-op (or caller-supplied) rejection handler to a value that may
 * be a `Promise<number>` returned from {@link FrameSink.write} or
 * {@link FrameSink.flush}. A no-op when the value is anything else.
 *
 * Bun's `FileSink` write/flush surface returns `number | Promise<number>`:
 * the synchronous `number` when the kernel pipe buffer accepted the bytes
 * immediately, or a `Promise<number>` when the bytes had to be buffered
 * (pipe was busy, partial write on Windows, etc.). If the read end is
 * closed before the buffered bytes drain, the Promise rejects with
 * `EPIPE: broken pipe, write` — and unlike the synchronous-throw path,
 * the rejection escapes any surrounding `try/catch` that does not `await`
 * the value. See issue #1741.
 */
function silenceSinkPromise(value: unknown, onAsyncFailure?: (err: Error) => void): void {
	if (
		value !== null &&
		typeof value === "object" &&
		"then" in value &&
		typeof (value as PromiseLike<unknown>).then === "function"
	) {
		(value as PromiseLike<unknown>).then(undefined, (err: unknown) => {
			onAsyncFailure?.(err instanceof Error ? err : new Error(String(err)));
		});
	}
}

/**
 * Write a newline-delimited JSON-RPC frame to the subprocess's stdin sink.
 *
 * Bun's `FileSink` may fail two ways when the read end of the pipe has
 * been closed by a subprocess that exited between read-loop ticks:
 *
 * 1. **Synchronously throws** — most reliably on Windows when the pipe is
 *    already torn down at call time. Returned as `false`.
 * 2. **Returns a `Promise<number>` that rejects later** — when the bytes
 *    were buffered and the pipe died before they drained. We treat this
 *    as a successful frame at the call site (the sync path saw no error)
 *    but route the eventual rejection through `onAsyncFailure` so it
 *    cannot escape as an unhandled promise rejection (#1741).
 *
 * Returns `true` when the frame was accepted synchronously, `false` when
 * the sink threw — callers signal transport closure on `false`. Callers
 * that need to react to the deferred `Promise` rejection MUST supply
 * `onAsyncFailure`; otherwise the rejection is silently dropped.
 */
export function writeFrame(stdin: FrameSink, frame: string, onAsyncFailure?: (err: Error) => void): boolean {
	try {
		silenceSinkPromise(stdin.write(frame), onAsyncFailure);
		silenceSinkPromise(stdin.flush(), onAsyncFailure);
		return true;
	} catch {
		return false;
	}
}

/**
 * Stdio transport for MCP servers.
 * Spawns a subprocess and communicates via stdin/stdout.
 */
export class StdioTransport implements MCPTransport {
	#process: Subprocess<"pipe", "pipe", "pipe"> | null = null;
	#pendingRequests = new Map<
		string | number,
		{
			resolve: (value: unknown) => void;
			reject: (error: Error) => void;
		}
	>();
	#connected = false;
	#readLoop: Promise<void> | null = null;

	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	onRequest?: (method: string, params: unknown) => Promise<unknown>;

	constructor(private config: MCPStdioServerConfig) {}

	get connected(): boolean {
		return this.#connected;
	}

	/**
	 * Start the subprocess and begin reading.
	 */
	async connect(): Promise<void> {
		if (this.#connected) return;

		const args = this.config.args ?? [];
		const env = {
			...Bun.env,
			...this.config.env,
		};

		this.#process = spawn({
			cmd: [this.config.command, ...args],
			cwd: this.config.cwd ?? getProjectDir(),
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});

		this.#connected = true;

		// Start reading stdout
		this.#readLoop = this.#startReadLoop();

		// Log stderr for debugging
		this.#startStderrLoop();
	}

	async #startReadLoop(): Promise<void> {
		if (!this.#process?.stdout) return;
		try {
			for await (const line of readJsonl(this.#process.stdout)) {
				if (!this.#connected) break;
				try {
					this.#handleMessage(line as JsonRpcMessage);
				} catch {
					// Skip malformed lines
				}
			}
		} catch (error) {
			if (this.#connected) {
				this.onError?.(error instanceof Error ? error : new Error(String(error)));
			}
		} finally {
			this.#handleClose();
		}
	}

	async #startStderrLoop(): Promise<void> {
		if (!this.#process?.stderr) return;

		const reader = this.#process.stderr.getReader();
		const decoder = new TextDecoder();

		try {
			while (this.#connected) {
				const { done, value } = await reader.read();
				if (done) break;
				// Log stderr but don't treat as error - servers use it for logging
				const text = decoder.decode(value, { stream: true });
				if (text.trim()) {
					// Could expose via onStderr callback if needed
					// For now, silent - MCP spec says clients MAY capture/ignore
				}
			}
		} catch {
			// Ignore stderr read errors
		} finally {
			reader.releaseLock();
		}
	}

	#handleMessage(message: JsonRpcMessage | JsonRpcMessage[]): void {
		if (Array.isArray(message)) {
			for (const m of message) this.#handleMessage(m);
			return;
		}
		// Server-to-client request: has both method and id
		if ("method" in message && "id" in message && message.id != null) {
			void this.#handleServerRequest(message as JsonRpcRequest);
			return;
		}

		// Response to our request: has id
		if ("id" in message && message.id != null) {
			const response = message as JsonRpcResponse;
			const pending = this.#pendingRequests.get(response.id);
			if (pending) {
				this.#pendingRequests.delete(response.id);
				if (response.error) {
					pending.reject(new Error(`MCP error ${response.error.code}: ${response.error.message}`));
				} else {
					pending.resolve(response.result);
				}
			}
			return;
		}

		// Notification: has method but no id
		if ("method" in message) {
			const notification = message as { method: string; params?: unknown };
			this.onNotification?.(notification.method, notification.params);
		}
	}

	async #handleServerRequest(request: JsonRpcRequest): Promise<void> {
		try {
			if (!this.onRequest) {
				this.#sendResponse(request.id, undefined, { code: -32601, message: "Method not found" });
				return;
			}
			const result = await this.onRequest(request.method, request.params);
			this.#sendResponse(request.id, result);
		} catch (error) {
			this.#sendResponse(request.id, undefined, toJsonRpcError(error));
		}
	}

	#sendResponse(id: string | number, result?: unknown, error?: JsonRpcError): void {
		if (!this.#connected || !this.#process?.stdin) return;
		const response = error
			? { jsonrpc: "2.0" as const, id, error }
			: { jsonrpc: "2.0" as const, id, result: result ?? {} };
		// Silent on failure — a dead subprocess has no use for the response,
		// and the read loop will close the transport on EOF.
		writeFrame(this.#process.stdin, `${JSON.stringify(response)}\n`);
	}

	#handleClose(): void {
		if (!this.#connected) return;
		this.#connected = false;

		// Reject all pending requests
		for (const [, pending] of this.#pendingRequests) {
			pending.reject(new Error("Transport closed"));
		}
		this.#pendingRequests.clear();

		this.onClose?.();
	}

	async request<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options?: MCPRequestOptions,
	): Promise<T> {
		if (!this.#connected || !this.#process?.stdin) {
			throw new Error("Transport not connected");
		}

		const id = Snowflake.next();
		const request = {
			jsonrpc: "2.0" as const,
			id,
			method,
			params: params ?? {},
		};

		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		const signal = options?.signal;

		if (signal?.aborted) {
			const reason = signal.reason instanceof Error ? signal.reason : new Error("Aborted");
			return Promise.reject(reason);
		}

		const { promise, resolve, reject } = Promise.withResolvers<T>();
		let timer: NodeJS.Timeout | undefined;
		let settled = false;

		const cleanup = () => {
			if (settled) return;
			settled = true;
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			if (signal) {
				signal.removeEventListener("abort", onAbort);
			}
			this.#pendingRequests.delete(id);
		};

		const onAbort = () => {
			cleanup();
			const reason = signal?.reason instanceof Error ? signal.reason : new Error("Aborted");
			reject(reason);
		};

		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
		}

		this.#pendingRequests.set(id, {
			resolve: (value: unknown) => {
				cleanup();
				resolve(value as T);
			},
			reject: (error: Error) => {
				cleanup();
				reject(error);
			},
		});

		if (isMCPTimeoutEnabled(timeout)) {
			timer = setTimeout(() => {
				cleanup();
				reject(new Error(`Request timeout after ${timeout}ms`));
			}, timeout);
		}

		const message = `${JSON.stringify(request)}\n`;
		// Route both sync throws AND deferred Promise rejections (Windows pipe
		// write rejecting later — see #1741) through the same reject path so
		// the pending request never hangs and no unhandled rejection escapes.
		const onWriteFailure = (error: unknown) => {
			const failure = error instanceof Error ? error : new Error(String(error));
			cleanup();
			reject(failure);
			// A failed write means the pipe is dead; tear the transport down
			// so other pending requests / notify() / the manager's onClose
			// observe the closure immediately instead of waiting for the read
			// loop to see EOF.
			this.#handleClose();
		};
		try {
			silenceSinkPromise(this.#process.stdin.write(message), onWriteFailure);
			silenceSinkPromise(this.#process.stdin.flush(), onWriteFailure);
		} catch (error: unknown) {
			onWriteFailure(error);
		}

		return promise;
	}

	async notify(method: string, params?: Record<string, unknown>): Promise<void> {
		if (!this.#connected || !this.#process?.stdin) {
			throw new Error("Transport not connected");
		}

		const notification = {
			jsonrpc: "2.0" as const,
			method,
			params: params ?? {},
		};

		// Bun's `FileSink` can fail two ways on Windows when the subprocess
		// has exited between the last read-loop tick and this write (e.g. an
		// MCP server that dies after returning `initialize` but before
		// `notifications/initialized`):
		//
		//   - sync throw → `writeFrame` returns `false` and we tear down
		//     here. `initializeConnection()` runs before the manager wires
		//     its `onClose` handler, so the caller MUST see the failure or a
		//     "connected" handle wraps a dead transport (see #1710).
		//   - deferred `Promise<number>` rejection → routed through
		//     `onAsyncFailure` so it tears the transport down instead of
		//     escaping as an unhandled rejection (see #1741).
		const frame = `${JSON.stringify(notification)}\n`;
		if (!writeFrame(this.#process.stdin, frame, () => this.#handleClose())) {
			this.#handleClose();
			throw new Error(`Transport closed while sending notification "${method}"`);
		}
	}

	async close(): Promise<void> {
		// `close()` is the authoritative resource teardown. `#handleClose()`
		// may have already run (read-loop EOF, or a notify() write failure
		// that surfaces the dead transport to the caller) and flipped
		// `#connected` to false — but the subprocess and read loop are still
		// alive in that path, so we MUST keep cleaning up regardless. Each
		// step is individually guarded so this remains idempotent across
		// repeat calls.
		if (this.#connected) {
			this.#handleClose();
		}

		if (this.#process) {
			this.#process.kill();
			this.#process = null;
		}

		if (this.#readLoop) {
			await this.#readLoop.catch(() => {});
			this.#readLoop = null;
		}
	}
}

/**
 * Create and connect a stdio transport.
 */
export async function createStdioTransport(config: MCPStdioServerConfig): Promise<StdioTransport> {
	const transport = new StdioTransport(config);
	await transport.connect();
	return transport;
}
