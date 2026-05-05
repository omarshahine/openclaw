import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { describe, expect, it, vi } from "vitest";

const probeMock = vi.hoisted(() => ({
  getCachedIMessagePrivateApiStatus: vi.fn(),
}));

const runtimeMock = vi.hoisted(() => ({
  resolveIMessageMessageId: vi.fn((id: string) => id),
  resolveChatGuidForTarget: vi.fn(),
  sendReaction: vi.fn(),
  sendRichMessage: vi.fn(),
  sendAttachment: vi.fn(),
}));

vi.mock("./probe.js", () => ({
  getCachedIMessagePrivateApiStatus: probeMock.getCachedIMessagePrivateApiStatus,
}));

vi.mock("./actions.runtime.js", () => ({
  imessageActionsRuntime: runtimeMock,
}));

const { imessageMessageActions } = await import("./actions.js");

function cfg(actions?: Record<string, boolean | undefined>): OpenClawConfig {
  return {
    channels: {
      imessage: {
        cliPath: "imsg",
        actions,
      },
    },
  } as OpenClawConfig;
}

describe("imessage message actions", () => {
  it("does not advertise private API actions until the bridge is available", () => {
    probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
      available: false,
      v2Ready: false,
      selectors: {},
    });

    const described = imessageMessageActions.describeMessageTool({
      cfg: cfg(),
      currentChannelId: "chat_guid:iMessage;+;chat0000",
    } as never);

    expect(described?.actions).toEqual([]);
  });

  it("advertises BB-parity actions when private API and selectors are available", () => {
    probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
      available: true,
      v2Ready: true,
      selectors: {
        editMessage: true,
        retractMessagePart: true,
      },
    });

    const described = imessageMessageActions.describeMessageTool({
      cfg: cfg(),
      currentChannelId: "chat_guid:iMessage;+;chat0000",
    } as never);

    expect(described?.actions).toEqual(
      expect.arrayContaining([
        "react",
        "edit",
        "unsend",
        "reply",
        "sendWithEffect",
        "renameGroup",
        "setGroupIcon",
        "addParticipant",
        "removeParticipant",
        "leaveGroup",
        "upload-file",
      ]),
    );
  });

  it("respects configured action gates", () => {
    probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
      available: true,
      v2Ready: true,
      selectors: {
        editMessage: true,
        retractMessagePart: true,
      },
    });

    const described = imessageMessageActions.describeMessageTool({
      cfg: cfg({ reactions: false, reply: false }),
      currentChannelId: "chat_guid:iMessage;+;chat0000",
    } as never);

    expect(described?.actions).not.toContain("react");
    expect(described?.actions).not.toContain("reply");
    expect(described?.actions).toContain("edit");
  });

  it("maps message tool reactions to imsg tapback kinds", async () => {
    probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
      available: true,
      v2Ready: true,
      selectors: {},
    });
    runtimeMock.sendReaction.mockResolvedValue(undefined);

    await imessageMessageActions.handleAction?.({
      action: "react",
      cfg: cfg(),
      params: {
        chatGuid: "iMessage;+;chat0000",
        messageId: "message-guid",
        emoji: "👍",
      },
    } as never);

    expect(runtimeMock.sendReaction).toHaveBeenCalledWith(
      expect.objectContaining({
        chatGuid: "iMessage;+;chat0000",
        messageId: "message-guid",
        reaction: "like",
      }),
    );
  });

  it("resolves chat_id targets before invoking bridge actions", async () => {
    probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
      available: true,
      v2Ready: true,
      selectors: {},
    });
    runtimeMock.resolveChatGuidForTarget.mockResolvedValue("iMessage;+;resolved");
    runtimeMock.sendReaction.mockResolvedValue(undefined);

    await imessageMessageActions.handleAction?.({
      action: "react",
      cfg: cfg(),
      params: {
        target: "chat_id:42",
        messageId: "message-guid",
        emoji: "👍",
      },
    } as never);

    expect(runtimeMock.resolveChatGuidForTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "chat_id", chatId: 42 },
      }),
    );
    expect(runtimeMock.sendReaction).toHaveBeenCalledWith(
      expect.objectContaining({
        chatGuid: "iMessage;+;resolved",
      }),
    );
  });

  it("resolves short message ids before invoking bridge actions", async () => {
    probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
      available: true,
      v2Ready: true,
      selectors: {},
    });
    runtimeMock.resolveIMessageMessageId.mockReturnValueOnce("full-guid");
    runtimeMock.sendReaction.mockResolvedValue(undefined);

    await imessageMessageActions.handleAction?.({
      action: "react",
      cfg: cfg(),
      params: {
        chatGuid: "iMessage;+;chat0000",
        messageId: "1",
        emoji: "👍",
      },
    } as never);

    expect(runtimeMock.resolveIMessageMessageId).toHaveBeenCalledWith("1", {
      requireKnownShortId: true,
      chatContext: {
        chatGuid: "iMessage;+;chat0000",
        chatIdentifier: undefined,
        chatId: undefined,
      },
    });
    expect(runtimeMock.sendReaction).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "full-guid",
      }),
    );
  });

  it("resolves chat_identifier targets before invoking bridge actions", async () => {
    probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
      available: true,
      v2Ready: true,
      selectors: {},
    });
    runtimeMock.resolveChatGuidForTarget.mockResolvedValue("iMessage;+;resolved-ident");
    runtimeMock.sendRichMessage.mockResolvedValue({ messageId: "reply-guid" });

    await imessageMessageActions.handleAction?.({
      action: "reply",
      cfg: cfg(),
      params: {
        chatIdentifier: "team-thread",
        messageId: "message-guid",
        text: "reply",
      },
    } as never);

    expect(runtimeMock.resolveChatGuidForTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "chat_identifier", chatIdentifier: "team-thread" },
      }),
    );
    expect(runtimeMock.sendRichMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatGuid: "iMessage;+;resolved-ident",
      }),
    );
  });

  it("routes upload-file through the private API attachment bridge", async () => {
    probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
      available: true,
      v2Ready: true,
      selectors: {},
    });
    runtimeMock.sendAttachment.mockResolvedValue({ messageId: "sent-guid" });

    const result = await imessageMessageActions.handleAction?.({
      action: "upload-file",
      cfg: cfg(),
      params: {
        chatGuid: "iMessage;+;chat0000",
        filename: "photo.jpg",
        buffer: Buffer.from("image").toString("base64"),
      },
    } as never);

    expect(runtimeMock.sendAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        chatGuid: "iMessage;+;chat0000",
        filename: "photo.jpg",
      }),
    );
    expect(result?.details).toEqual({ ok: true, messageId: "sent-guid" });
  });
});
