import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

const REPLY_CACHE_MAX = 2000;
const REPLY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export type IMessageChatContext = {
  chatGuid?: string;
  chatIdentifier?: string;
  chatId?: number;
};

type IMessageReplyCacheEntry = IMessageChatContext & {
  accountId: string;
  messageId: string;
  shortId: string;
  timestamp: number;
};

const imessageReplyCacheByMessageId = new Map<string, IMessageReplyCacheEntry>();
const imessageShortIdToUuid = new Map<string, string>();
const imessageUuidToShortId = new Map<string, string>();
let imessageShortIdCounter = 0;

function generateShortId(): string {
  imessageShortIdCounter += 1;
  return String(imessageShortIdCounter);
}

export function rememberIMessageReplyCache(
  entry: Omit<IMessageReplyCacheEntry, "shortId">,
): IMessageReplyCacheEntry {
  const messageId = entry.messageId.trim();
  if (!messageId) {
    return { ...entry, shortId: "" };
  }

  let shortId = imessageUuidToShortId.get(messageId);
  if (!shortId) {
    shortId = generateShortId();
    imessageShortIdToUuid.set(shortId, messageId);
    imessageUuidToShortId.set(messageId, shortId);
  }

  const fullEntry: IMessageReplyCacheEntry = { ...entry, messageId, shortId };
  imessageReplyCacheByMessageId.delete(messageId);
  imessageReplyCacheByMessageId.set(messageId, fullEntry);

  const cutoff = Date.now() - REPLY_CACHE_TTL_MS;
  for (const [key, value] of imessageReplyCacheByMessageId) {
    if (value.timestamp >= cutoff) {
      break;
    }
    imessageReplyCacheByMessageId.delete(key);
    if (value.shortId) {
      imessageShortIdToUuid.delete(value.shortId);
      imessageUuidToShortId.delete(key);
    }
  }
  while (imessageReplyCacheByMessageId.size > REPLY_CACHE_MAX) {
    const oldest = imessageReplyCacheByMessageId.keys().next().value;
    if (!oldest) {
      break;
    }
    const oldEntry = imessageReplyCacheByMessageId.get(oldest);
    imessageReplyCacheByMessageId.delete(oldest);
    if (oldEntry?.shortId) {
      imessageShortIdToUuid.delete(oldEntry.shortId);
      imessageUuidToShortId.delete(oldest);
    }
  }

  return fullEntry;
}

function hasChatScope(ctx?: IMessageChatContext): boolean {
  if (!ctx) {
    return false;
  }
  return Boolean(
    normalizeOptionalString(ctx.chatGuid) ||
    normalizeOptionalString(ctx.chatIdentifier) ||
    typeof ctx.chatId === "number",
  );
}

function isCrossChatMismatch(cached: IMessageReplyCacheEntry, ctx: IMessageChatContext): boolean {
  const cachedChatGuid = normalizeOptionalString(cached.chatGuid);
  const ctxChatGuid = normalizeOptionalString(ctx.chatGuid);
  if (cachedChatGuid && ctxChatGuid) {
    return cachedChatGuid !== ctxChatGuid;
  }
  const cachedChatIdentifier = normalizeOptionalString(cached.chatIdentifier);
  const ctxChatIdentifier = normalizeOptionalString(ctx.chatIdentifier);
  if (cachedChatIdentifier && ctxChatIdentifier) {
    return cachedChatIdentifier !== ctxChatIdentifier;
  }
  const cachedChatId = typeof cached.chatId === "number" ? cached.chatId : undefined;
  const ctxChatId = typeof ctx.chatId === "number" ? ctx.chatId : undefined;
  if (cachedChatId !== undefined && ctxChatId !== undefined) {
    return cachedChatId !== ctxChatId;
  }
  return false;
}

function describeChatForError(values: IMessageChatContext): string {
  const parts: string[] = [];
  if (normalizeOptionalString(values.chatGuid)) {
    parts.push("chatGuid=<redacted>");
  }
  if (normalizeOptionalString(values.chatIdentifier)) {
    parts.push("chatIdentifier=<redacted>");
  }
  if (typeof values.chatId === "number") {
    parts.push("chatId=<redacted>");
  }
  return parts.length === 0 ? "<unknown chat>" : parts.join(", ");
}

function describeMessageIdForError(inputId: string, inputKind: "short" | "uuid"): string {
  if (inputKind === "short") {
    return `<short:${inputId.length}-digit>`;
  }
  return `<uuid:${inputId.slice(0, 8)}...>`;
}

function buildCrossChatError(
  inputId: string,
  inputKind: "short" | "uuid",
  cached: IMessageReplyCacheEntry,
  ctx: IMessageChatContext,
): Error {
  const remediation =
    inputKind === "short"
      ? "Retry with MessageSidFull to avoid cross-chat reactions/replies landing in the wrong conversation."
      : "Retry with the correct chat target.";
  return new Error(
    `iMessage message id ${describeMessageIdForError(inputId, inputKind)} belongs to a different chat ` +
      `(${describeChatForError(cached)}) than the current call target (${describeChatForError(ctx)}). ${remediation}`,
  );
}

export function resolveIMessageMessageId(
  shortOrUuid: string,
  opts?: { requireKnownShortId?: boolean; chatContext?: IMessageChatContext },
): string {
  const trimmed = shortOrUuid.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (/^\d+$/.test(trimmed)) {
    if (opts?.requireKnownShortId && !hasChatScope(opts.chatContext)) {
      throw new Error(
        `iMessage short message id ${describeMessageIdForError(trimmed, "short")} requires a chat scope (chatGuid / chatIdentifier / chatId or a target).`,
      );
    }
    const uuid = imessageShortIdToUuid.get(trimmed);
    if (uuid) {
      if (opts?.chatContext) {
        const cached = imessageReplyCacheByMessageId.get(uuid);
        if (cached && isCrossChatMismatch(cached, opts.chatContext)) {
          throw buildCrossChatError(trimmed, "short", cached, opts.chatContext);
        }
      }
      return uuid;
    }
    if (opts?.requireKnownShortId) {
      throw new Error(
        `iMessage short message id ${describeMessageIdForError(trimmed, "short")} is no longer available. Use MessageSidFull.`,
      );
    }
    return trimmed;
  }

  if (opts?.chatContext) {
    const cached = imessageReplyCacheByMessageId.get(trimmed);
    if (cached && isCrossChatMismatch(cached, opts.chatContext)) {
      throw buildCrossChatError(trimmed, "uuid", cached, opts.chatContext);
    }
  }
  return trimmed;
}

export function _resetIMessageShortIdState(): void {
  imessageReplyCacheByMessageId.clear();
  imessageShortIdToUuid.clear();
  imessageUuidToShortId.clear();
  imessageShortIdCounter = 0;
}
