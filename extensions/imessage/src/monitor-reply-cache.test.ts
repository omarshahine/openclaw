import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetIMessageShortIdState,
  rememberIMessageReplyCache,
  resolveIMessageMessageId,
} from "./monitor-reply-cache.js";

beforeEach(() => {
  _resetIMessageShortIdState();
});

describe("imessage short message id resolution", () => {
  it("resolves a short id to a cached message guid", () => {
    const entry = rememberIMessageReplyCache({
      accountId: "default",
      messageId: "full-guid",
      chatGuid: "iMessage;+;chat0000",
      timestamp: Date.now(),
    });

    expect(entry.shortId).toBe("1");
    expect(
      resolveIMessageMessageId("1", {
        requireKnownShortId: true,
        chatContext: { chatGuid: "iMessage;+;chat0000" },
      }),
    ).toBe("full-guid");
  });

  it("requires chat scope for privileged short-id resolution", () => {
    rememberIMessageReplyCache({
      accountId: "default",
      messageId: "full-guid",
      chatGuid: "iMessage;+;chat0000",
      timestamp: Date.now(),
    });

    expect(() => resolveIMessageMessageId("1", { requireKnownShortId: true })).toThrow(
      "requires a chat scope",
    );
  });

  it("rejects short ids from another chat", () => {
    rememberIMessageReplyCache({
      accountId: "default",
      messageId: "full-guid",
      chatGuid: "iMessage;+;chat0000",
      timestamp: Date.now(),
    });

    expect(() =>
      resolveIMessageMessageId("1", {
        requireKnownShortId: true,
        chatContext: { chatGuid: "iMessage;+;other" },
      }),
    ).toThrow("belongs to a different chat");
  });

  it("guards full guid reuse across chats when cached", () => {
    rememberIMessageReplyCache({
      accountId: "default",
      messageId: "full-guid",
      chatId: 42,
      timestamp: Date.now(),
    });

    expect(() => resolveIMessageMessageId("full-guid", { chatContext: { chatId: 99 } })).toThrow(
      "belongs to a different chat",
    );
  });
});
