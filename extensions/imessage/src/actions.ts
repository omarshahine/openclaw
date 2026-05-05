import { readBooleanParam } from "openclaw/plugin-sdk/boolean-param";
import {
  createActionGate,
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringParam,
} from "openclaw/plugin-sdk/channel-actions";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
} from "openclaw/plugin-sdk/channel-contract";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";
import { resolveIMessageAccount } from "./accounts.js";
import { IMESSAGE_ACTION_NAMES, IMESSAGE_ACTIONS } from "./actions-contract.js";
import type { IMessageChatContext } from "./monitor-reply-cache.js";
import { normalizeIMessageMessagingTarget } from "./normalize.js";
import { getCachedIMessagePrivateApiStatus } from "./probe.js";
import { parseIMessageTarget, type IMessageTarget } from "./targets.js";

const loadIMessageActionsRuntime = createLazyRuntimeNamedExport(
  () => import("./actions.runtime.js"),
  "imessageActionsRuntime",
);

const providerId = "imessage";

const SUPPORTED_ACTIONS = new Set<ChannelMessageActionName>([
  ...IMESSAGE_ACTION_NAMES,
  "upload-file",
]);
const PRIVATE_API_ACTIONS = new Set<ChannelMessageActionName>([
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
  "sendAttachment",
]);

function readMessageText(params: Record<string, unknown>): string | undefined {
  return readStringParam(params, "text") ?? readStringParam(params, "message");
}

function readMessageId(params: Record<string, unknown>): string {
  return readStringParam(params, "messageId", { required: true });
}

function isGroupTarget(raw?: string | null): boolean {
  const normalized = raw ? normalizeIMessageMessagingTarget(raw) : undefined;
  const lowered = normalizeOptionalLowercaseString(normalized) ?? "";
  return (
    lowered.startsWith("chat_guid:") ||
    lowered.startsWith("chat_id:") ||
    lowered.startsWith("chat_identifier:") ||
    lowered.startsWith("group:")
  );
}

type IMessageActionsRuntime = Awaited<ReturnType<typeof loadIMessageActionsRuntime>>;

async function resolveChatGuid(params: {
  action: ChannelMessageActionName;
  actionParams: Record<string, unknown>;
  currentChannelId?: string;
  runtime: IMessageActionsRuntime;
  options: {
    cliPath: string;
    dbPath?: string;
    timeoutMs?: number;
  };
}): Promise<string> {
  const explicitChatGuid = readStringParam(params.actionParams, "chatGuid");
  if (explicitChatGuid) {
    return explicitChatGuid;
  }
  const explicitChatId = readNumberParam(params.actionParams, "chatId", { integer: true });
  if (typeof explicitChatId === "number") {
    const resolved = await params.runtime.resolveChatGuidForTarget({
      target: { kind: "chat_id", chatId: explicitChatId },
      options: params.options,
    });
    if (resolved) {
      return resolved;
    }
    throw new Error(
      `iMessage ${params.action} failed: chatGuid not found for chat_id:${explicitChatId}.`,
    );
  }
  const explicitChatIdentifier = readStringParam(params.actionParams, "chatIdentifier");
  if (explicitChatIdentifier) {
    const resolved = await params.runtime.resolveChatGuidForTarget({
      target: { kind: "chat_identifier", chatIdentifier: explicitChatIdentifier },
      options: params.options,
    });
    if (resolved) {
      return resolved;
    }
    throw new Error(
      `iMessage ${params.action} failed: chatGuid not found for chat_identifier:${explicitChatIdentifier}.`,
    );
  }
  const rawTarget =
    readStringParam(params.actionParams, "to") ??
    readStringParam(params.actionParams, "target") ??
    params.currentChannelId;
  if (rawTarget) {
    const target = parseIMessageTarget(rawTarget);
    if (target.kind === "chat_guid") {
      return target.chatGuid;
    }
    if (target.kind === "chat_id" || target.kind === "chat_identifier") {
      const resolved = await params.runtime.resolveChatGuidForTarget({
        target,
        options: params.options,
      });
      if (resolved) {
        return resolved;
      }
      throw new Error(
        `iMessage ${params.action} failed: chatGuid not found for ${formatUnresolvedTarget(target)}.`,
      );
    }
  }
  throw new Error(
    `iMessage ${params.action} requires chatGuid, chatId, chatIdentifier, or a chat target.`,
  );
}

function formatUnresolvedTarget(
  target: Extract<IMessageTarget, { kind: "chat_id" | "chat_identifier" }>,
): string {
  return target.kind === "chat_id"
    ? `chat_id:${target.chatId}`
    : `chat_identifier:${target.chatIdentifier}`;
}

function buildChatContextFromActionParams(params: {
  actionParams: Record<string, unknown>;
  currentChannelId?: string;
}): IMessageChatContext {
  const explicitChatGuid = readStringParam(params.actionParams, "chatGuid")?.trim();
  const explicitChatIdentifier = readStringParam(params.actionParams, "chatIdentifier")?.trim();
  const explicitChatId = readNumberParam(params.actionParams, "chatId", { integer: true });
  const rawTarget =
    readStringParam(params.actionParams, "to") ??
    readStringParam(params.actionParams, "target") ??
    params.currentChannelId;
  const target = rawTarget ? parseIMessageTarget(rawTarget) : null;
  return {
    chatGuid: explicitChatGuid || (target?.kind === "chat_guid" ? target.chatGuid : undefined),
    chatIdentifier:
      explicitChatIdentifier ||
      (target?.kind === "chat_identifier" ? target.chatIdentifier : undefined),
    chatId:
      typeof explicitChatId === "number"
        ? explicitChatId
        : target?.kind === "chat_id"
          ? target.chatId
          : undefined,
  };
}

function mapTapbackReaction(emoji?: string): string | undefined {
  const value = normalizeOptionalLowercaseString(emoji)?.replace(/\ufe0f/g, "");
  if (!value) {
    return undefined;
  }
  if (["love", "heart", "❤", "❤️"].includes(value)) {
    return "love";
  }
  if (["like", "+1", "thumbsup", "👍"].includes(value)) {
    return "like";
  }
  if (["dislike", "-1", "thumbsdown", "👎"].includes(value)) {
    return "dislike";
  }
  if (["laugh", "haha", "😂", "🤣"].includes(value)) {
    return "laugh";
  }
  if (["emphasize", "!!", "‼", "‼️"].includes(value)) {
    return "emphasize";
  }
  if (["question", "?", "？", "❓"].includes(value)) {
    return "question";
  }
  return undefined;
}

function decodeBase64Buffer(params: Record<string, unknown>, action: string): Uint8Array {
  const base64Buffer = readStringParam(params, "buffer");
  if (!base64Buffer) {
    throw new Error(`iMessage ${action} requires buffer (base64) parameter.`);
  }
  return Uint8Array.from(Buffer.from(base64Buffer, "base64"));
}

function effectIdFromParam(raw?: string): string | undefined {
  const value = normalizeOptionalLowercaseString(raw);
  if (!value) {
    return undefined;
  }
  if (value.startsWith("com.apple.")) {
    return raw;
  }
  const aliases: Record<string, string> = {
    slam: "com.apple.MobileSMS.expressivesend.impact",
    impact: "com.apple.MobileSMS.expressivesend.impact",
    loud: "com.apple.MobileSMS.expressivesend.loud",
    gentle: "com.apple.MobileSMS.expressivesend.gentle",
    "invisible-ink": "com.apple.MobileSMS.expressivesend.invisibleink",
    invisibleink: "com.apple.MobileSMS.expressivesend.invisibleink",
    confetti: "com.apple.MobileSMS.expressivesend.confetti",
    lasers: "com.apple.MobileSMS.expressivesend.lasers",
    fireworks: "com.apple.MobileSMS.expressivesend.fireworks",
    balloons: "com.apple.MobileSMS.expressivesend.balloon",
    balloon: "com.apple.MobileSMS.expressivesend.balloon",
    heart: "com.apple.MobileSMS.expressivesend.heart",
  };
  return aliases[value] ?? raw;
}

export const imessageMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: ({ cfg, accountId, currentChannelId }) => {
    const account = resolveIMessageAccount({ cfg, accountId });
    if (!account.enabled || !account.configured) {
      return null;
    }
    const privateApiStatus = getCachedIMessagePrivateApiStatus(
      account.config.cliPath?.trim() || "imsg",
    );
    const privateApiEnabled = privateApiStatus?.available === true;
    const gate = createActionGate(account.config.actions);
    const actions = new Set<ChannelMessageActionName>();
    for (const action of IMESSAGE_ACTION_NAMES) {
      const spec = IMESSAGE_ACTIONS[action];
      if (!spec?.gate || !gate(spec.gate)) {
        continue;
      }
      if (PRIVATE_API_ACTIONS.has(action) && !privateApiEnabled) {
        continue;
      }
      if (
        action === "edit" &&
        privateApiStatus?.selectors &&
        !privateApiStatus.selectors.editMessage &&
        !privateApiStatus.selectors.editMessageItem
      ) {
        continue;
      }
      if (action === "unsend" && privateApiStatus?.selectors?.retractMessagePart !== true) {
        continue;
      }
      actions.add(action);
    }
    if (!isGroupTarget(currentChannelId)) {
      for (const action of IMESSAGE_ACTION_NAMES) {
        if ("groupOnly" in IMESSAGE_ACTIONS[action] && IMESSAGE_ACTIONS[action].groupOnly) {
          actions.delete(action);
        }
      }
    }
    if (actions.delete("sendAttachment")) {
      actions.add("upload-file");
    }
    return { actions: Array.from(actions) };
  },
  supportsAction: ({ action }) => SUPPORTED_ACTIONS.has(action),
  extractToolSend: ({ args }) => extractToolSend(args, "sendMessage"),
  handleAction: async ({ action, params, cfg, accountId, toolContext }) => {
    const runtime = await loadIMessageActionsRuntime();
    const account = resolveIMessageAccount({
      cfg,
      accountId: accountId ?? undefined,
    });
    const privateApiStatus = getCachedIMessagePrivateApiStatus(
      account.config.cliPath?.trim() || "imsg",
    );
    const assertPrivateApiEnabled = () => {
      if (privateApiStatus?.available !== true) {
        throw new Error(
          `iMessage ${action} requires the imsg private API bridge. Run imsg launch, then openclaw channels status to refresh capability detection.`,
        );
      }
    };
    const opts = {
      cliPath: account.config.cliPath?.trim() || "imsg",
      dbPath: account.config.dbPath?.trim() || undefined,
      timeoutMs: account.config.probeTimeoutMs,
      chatGuid: "",
    };
    const chatGuid = async () =>
      await resolveChatGuid({
        action,
        actionParams: params,
        currentChannelId: toolContext?.currentChannelId,
        runtime,
        options: opts,
      });
    const messageId = () =>
      runtime.resolveIMessageMessageId(readMessageId(params), {
        requireKnownShortId: true,
        chatContext: buildChatContextFromActionParams({
          actionParams: params,
          currentChannelId: toolContext?.currentChannelId,
        }),
      });

    if (action === "react") {
      assertPrivateApiEnabled();
      const { emoji, remove, isEmpty } = readReactionParams(params, {
        removeErrorMessage: "Emoji is required to remove an iMessage reaction.",
      });
      const reaction = mapTapbackReaction(emoji);
      if ((isEmpty && !remove) || !reaction) {
        throw new Error(
          "iMessage react supports love, like, dislike, laugh, emphasize, and question tapbacks.",
        );
      }
      const resolvedMessageId = messageId();
      const partIndex = readNumberParam(params, "partIndex", { integer: true });
      const resolvedChatGuid = await chatGuid();
      await runtime.sendReaction({
        chatGuid: resolvedChatGuid,
        messageId: resolvedMessageId,
        reaction,
        remove: remove || undefined,
        partIndex: typeof partIndex === "number" ? partIndex : undefined,
        options: { ...opts, chatGuid: resolvedChatGuid },
      });
      return jsonResult({ ok: true, ...(remove ? { removed: true } : { added: reaction }) });
    }

    if (action === "edit") {
      assertPrivateApiEnabled();
      const resolvedMessageId = messageId();
      const text =
        readStringParam(params, "text") ??
        readStringParam(params, "newText") ??
        readStringParam(params, "message");
      if (!text) {
        throw new Error("iMessage edit requires text, newText, or message.");
      }
      const partIndex = readNumberParam(params, "partIndex", { integer: true });
      const backwardsCompatMessage = readStringParam(params, "backwardsCompatMessage");
      const resolvedChatGuid = await chatGuid();
      await runtime.editMessage({
        chatGuid: resolvedChatGuid,
        messageId: resolvedMessageId,
        text,
        backwardsCompatMessage: backwardsCompatMessage ?? undefined,
        partIndex: typeof partIndex === "number" ? partIndex : undefined,
        options: { ...opts, chatGuid: resolvedChatGuid },
      });
      return jsonResult({ ok: true, edited: resolvedMessageId });
    }

    if (action === "unsend") {
      assertPrivateApiEnabled();
      const resolvedMessageId = messageId();
      const partIndex = readNumberParam(params, "partIndex", { integer: true });
      const resolvedChatGuid = await chatGuid();
      await runtime.unsendMessage({
        chatGuid: resolvedChatGuid,
        messageId: resolvedMessageId,
        partIndex: typeof partIndex === "number" ? partIndex : undefined,
        options: { ...opts, chatGuid: resolvedChatGuid },
      });
      return jsonResult({ ok: true, unsent: resolvedMessageId });
    }

    if (action === "reply") {
      assertPrivateApiEnabled();
      const resolvedMessageId = messageId();
      const text = readMessageText(params);
      if (!text) {
        throw new Error("iMessage reply requires text or message.");
      }
      const partIndex = readNumberParam(params, "partIndex", { integer: true });
      const resolvedChatGuid = await chatGuid();
      const result = await runtime.sendRichMessage({
        chatGuid: resolvedChatGuid,
        text,
        replyToMessageId: resolvedMessageId,
        partIndex: typeof partIndex === "number" ? partIndex : undefined,
        options: { ...opts, chatGuid: resolvedChatGuid },
      });
      return jsonResult({ ok: true, messageId: result.messageId, repliedTo: resolvedMessageId });
    }

    if (action === "sendWithEffect") {
      assertPrivateApiEnabled();
      const text = readMessageText(params);
      const effectId = effectIdFromParam(
        readStringParam(params, "effectId") ?? readStringParam(params, "effect"),
      );
      if (!text || !effectId) {
        throw new Error("iMessage sendWithEffect requires text/message and effect/effectId.");
      }
      const resolvedChatGuid = await chatGuid();
      const result = await runtime.sendRichMessage({
        chatGuid: resolvedChatGuid,
        text,
        effectId,
        options: { ...opts, chatGuid: resolvedChatGuid },
      });
      return jsonResult({ ok: true, messageId: result.messageId, effect: effectId });
    }

    if (action === "renameGroup") {
      assertPrivateApiEnabled();
      const displayName = readStringParam(params, "displayName") ?? readStringParam(params, "name");
      if (!displayName) {
        throw new Error("iMessage renameGroup requires displayName or name.");
      }
      const resolvedChatGuid = await chatGuid();
      await runtime.renameGroup({
        chatGuid: resolvedChatGuid,
        displayName,
        options: { ...opts, chatGuid: resolvedChatGuid },
      });
      return jsonResult({ ok: true, renamed: resolvedChatGuid, displayName });
    }

    if (action === "setGroupIcon") {
      assertPrivateApiEnabled();
      const filename =
        readStringParam(params, "filename") ?? readStringParam(params, "name") ?? "icon.png";
      const resolvedChatGuid = await chatGuid();
      await runtime.setGroupIcon({
        chatGuid: resolvedChatGuid,
        buffer: decodeBase64Buffer(params, action),
        filename,
        options: { ...opts, chatGuid: resolvedChatGuid },
      });
      return jsonResult({ ok: true, chatGuid: resolvedChatGuid, iconSet: true });
    }

    if (action === "addParticipant" || action === "removeParticipant") {
      assertPrivateApiEnabled();
      const address = readStringParam(params, "address") ?? readStringParam(params, "participant");
      if (!address) {
        throw new Error(`iMessage ${action} requires address or participant.`);
      }
      const resolvedChatGuid = await chatGuid();
      if (action === "addParticipant") {
        await runtime.addParticipant({
          chatGuid: resolvedChatGuid,
          address,
          options: { ...opts, chatGuid: resolvedChatGuid },
        });
        return jsonResult({ ok: true, added: address, chatGuid: resolvedChatGuid });
      }
      await runtime.removeParticipant({
        chatGuid: resolvedChatGuid,
        address,
        options: { ...opts, chatGuid: resolvedChatGuid },
      });
      return jsonResult({ ok: true, removed: address, chatGuid: resolvedChatGuid });
    }

    if (action === "leaveGroup") {
      assertPrivateApiEnabled();
      const resolvedChatGuid = await chatGuid();
      await runtime.leaveGroup({
        chatGuid: resolvedChatGuid,
        options: { ...opts, chatGuid: resolvedChatGuid },
      });
      return jsonResult({ ok: true, left: resolvedChatGuid });
    }

    if (action === "sendAttachment" || action === "upload-file") {
      assertPrivateApiEnabled();
      const filename = readStringParam(params, "filename", { required: true });
      const asVoice = readBooleanParam(params, "asVoice");
      const resolvedChatGuid = await chatGuid();
      const result = await runtime.sendAttachment({
        chatGuid: resolvedChatGuid,
        buffer: decodeBase64Buffer(params, action),
        filename,
        asVoice: asVoice ?? undefined,
        options: { ...opts, chatGuid: resolvedChatGuid },
      });
      return jsonResult({ ok: true, messageId: result.messageId });
    }

    throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
  },
};
