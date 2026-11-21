import type * as McpSchema from "effect/ai/McpSchema";

/** Schema classes are not safe to object-spread; copy their wire fields explicitly. */
export const toolFields = (tool: McpSchema.Tool) => ({
  name: tool.name,
  ...(tool.title === undefined ? {} : { title: tool.title }),
  ...(tool.description === undefined ? {} : { description: tool.description }),
  inputSchema: tool.inputSchema,
  ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
  ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
  ...(tool.icons === undefined ? {} : { icons: tool.icons }),
  ...(tool["_meta"] === undefined ? {} : { ["_meta"]: tool["_meta"] }),
});
