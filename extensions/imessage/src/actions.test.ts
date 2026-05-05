import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { describe, expect, it, vi } from "vitest";

const probeMock = vi.hoisted(() => ({
  getCachedIMessagePrivateApiStatus: vi.fn(),
}));

const runtimeMock = vi.hoisted(() => ({
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
