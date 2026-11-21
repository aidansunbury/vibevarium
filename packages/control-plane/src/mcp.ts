import type * as McpClientError from "effect/ai/McpClientError";
import type * as Headers from "effect/http/Headers";

const hopByHopHeaders = new Set([
  "accept",
  "connection",
  "content-length",
  "content-type",
  "host",
  "keep-alive",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Forward caller credentials and tracing/custom headers, but never another MCP session's transport state. */
export const forwardedHeaders = (headers: Headers.Headers): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(headers).filter(([name]) => !hopByHopHeaders.has(name) && !name.startsWith("mcp-")),
  );

export const describeClientError = (error: McpClientError.McpClientError) => ({
  _tag: error.reason["_tag"],
  message: error.message,
});
