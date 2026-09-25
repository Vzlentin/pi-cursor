import { describe, expect, it } from "vitest";
import { create, fromBinary } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
  InteractionQuerySchema,
  WebSearchRequestQuerySchema,
  AskQuestionInteractionQuerySchema,
  AskQuestionArgsSchema,
  SwitchModeRequestQuerySchema,
} from "../src/proto/agent_pb.js";
import { handleInteractionQuery } from "../src/stream/interaction-query.js";

describe("handleInteractionQuery", () => {
  it("rejects web search when explicitly disabled", () => {
    const frames: Uint8Array[] = [];
    const query = create(InteractionQuerySchema, {
      id: 7,
      query: {
        case: "webSearchRequestQuery",
        value: create(WebSearchRequestQuerySchema, {}),
      },
    });
    const result = handleInteractionQuery(query, (frame) => frames.push(frame), {
      approveWeb: false,
    });
    expect(result.handled).toBe(true);
    expect(result.action).toBe("web_search_rejected");
    expect(frames).toHaveLength(1);
  });

  it("approves web search by default so hosted fetch can complete the turn", () => {
    const frames: Uint8Array[] = [];
    const query = create(InteractionQuerySchema, {
      id: 8,
      query: {
        case: "webSearchRequestQuery",
        value: create(WebSearchRequestQuerySchema, {}),
      },
    });
    const result = handleInteractionQuery(query, (frame) => frames.push(frame));
    expect(result.handled).toBe(true);
    expect(result.action).toBe("web_search_approved");
    expect(frames).toHaveLength(1);
  });

  it("rejects Cursor mode switches", () => {
    const frames: Uint8Array[] = [];
    const query = create(InteractionQuerySchema, {
      id: 4,
      query: {
        case: "switchModeRequestQuery",
        value: create(SwitchModeRequestQuerySchema, {}),
      },
    });
    const result = handleInteractionQuery(query, (frame) => frames.push(frame));
    expect(result.handled).toBe(true);
    expect(result.action).toBe("switch_mode_rejected");
    expect(frames).toHaveLength(1);
  });

  it("reports an unavailable question UI, not a skipped or answered question", () => {
    const frames: Uint8Array[] = [];
    const query = create(InteractionQuerySchema, {
      id: 3,
      query: {
        case: "askQuestionInteractionQuery",
        value: create(AskQuestionInteractionQuerySchema, {
          args: create(AskQuestionArgsSchema, {}),
        }),
      },
    });
    const result = handleInteractionQuery(query, (frame) => frames.push(frame));
    expect(result.handled).toBe(true);
    expect(result.action).toBe("ask_question_unavailable");
    expect(frames).toHaveLength(1);
    const message = fromBinary(AgentClientMessageSchema, frames[0]!.subarray(5));
    expect(message.message.case).toBe("interactionResponse");
    if (message.message.case !== "interactionResponse") throw new Error("wrong response");
    expect(message.message.value.id).toBe(3);
    const response = message.message.value.result;
    if (response.case !== "askQuestionInteractionResponse") throw new Error("wrong query");
    const answer = response.value.result?.result;
    expect(answer?.case).toBe("error");
    if (answer?.case !== "error") throw new Error("must not invent a user answer");
    expect(answer.value.errorMessage).toContain("this question was not shown to the user");
    expect(answer.value.errorMessage).toContain("Do not retry this tool");
    expect(answer.value.errorMessage).toContain("wait for the user's reply");
  });

  it("approves unnamed proto field #9 so hosted web fetch can continue", () => {
    const frames: Uint8Array[] = [];
    const query = create(InteractionQuerySchema, { id: 11 });
    (
      query as unknown as { $unknown: Array<{ no: number; wireType: number; data: Uint8Array }> }
    ).$unknown = [{ no: 9, wireType: 2, data: new Uint8Array([0x0a, 0x00]) }];
    const result = handleInteractionQuery(query, (frame) => frames.push(frame));
    expect(result.handled).toBe(true);
    expect(result.action).toBe("unknown_field_9_approved");
    expect(frames).toHaveLength(1);
    expect(frames[0]!.byteLength).toBeGreaterThan(5);
  });

  it("fails closed for unknown future interaction fields", () => {
    const frames: Uint8Array[] = [];
    const query = create(InteractionQuerySchema, { id: 13 });
    (
      query as unknown as { $unknown: Array<{ no: number; wireType: number; data: Uint8Array }> }
    ).$unknown = [{ no: 99, wireType: 2, data: new Uint8Array() }];
    const result = handleInteractionQuery(query, (frame) => frames.push(frame));
    expect(result).toMatchObject({ handled: false, action: "unknown_field_99_rejected" });
    expect(frames).toHaveLength(0);
  });
});
