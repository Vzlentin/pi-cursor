/** Shared limits for live and replayed tool results. Recovery must not shrink them. */
import type { ParsedImageContent, ParsedToolResult } from "./types.js";

export const MAX_MCP_TOOL_TEXT_BYTES = 512 * 1024;
export const MAX_MCP_TOOL_RESULT_BYTES = 16 * 1024 * 1024;

function truncateUtf8(text: string, maxBytes: number, originalBytes: number): string {
  const suffix = `\n\n[pi-cursor truncated this tool result from ${originalBytes} bytes to protect the agent context. Use a narrower command, path, or line range.]`;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const bytes = Buffer.from(text, "utf8");
  let end = Math.max(0, maxBytes - suffixBytes);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8") + suffix;
}

/** Bound a response consistently before journaling, live transport, or prompt replay. */
export function normalizeToolResultForTransport(
  result: Omit<ParsedToolResult, "isError"> & { isError?: boolean },
): ParsedToolResult {
  const originalTextBytes = Buffer.byteLength(result.content, "utf8");
  let content =
    originalTextBytes > MAX_MCP_TOOL_TEXT_BYTES
      ? truncateUtf8(result.content, MAX_MCP_TOOL_TEXT_BYTES, originalTextBytes)
      : result.content;

  const images: ParsedImageContent[] = [];
  let usedBytes = Buffer.byteLength(content, "utf8");
  let droppedImages = 0;
  let droppedImageBytes = 0;
  for (const image of result.images ?? []) {
    const imageBytes = image.data.byteLength + Buffer.byteLength(image.mimeType, "utf8");
    if (usedBytes + imageBytes > MAX_MCP_TOOL_RESULT_BYTES) {
      droppedImages += 1;
      droppedImageBytes += image.data.byteLength;
      continue;
    }
    images.push(image);
    usedBytes += imageBytes;
  }

  if (droppedImages > 0) {
    const notice = `\n\n[pi-cursor omitted ${droppedImages} oversized tool image(s), totaling ${droppedImageBytes} bytes, to protect the transport.]`;
    const combined = content + notice;
    const combinedBytes = Buffer.byteLength(combined, "utf8");
    content =
      combinedBytes > MAX_MCP_TOOL_TEXT_BYTES
        ? truncateUtf8(combined, MAX_MCP_TOOL_TEXT_BYTES, combinedBytes)
        : combined;
  }

  return {
    content,
    isError: result.isError === true,
    ...(images.length > 0 && { images }),
  };
}
