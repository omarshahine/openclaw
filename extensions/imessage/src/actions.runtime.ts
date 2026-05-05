import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

type CliRunOptions = {
  cliPath: string;
  timeoutMs?: number;
};

type IMessageBridgeActionOptions = CliRunOptions & {
  chatGuid: string;
};

type IMessageBridgeSendResult = {
  messageId: string;
};

type TempFileInput = {
  buffer: Uint8Array;
  filename: string;
};

async function runIMessageCliJson(
  args: readonly string[],
  options: CliRunOptions,
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const child = spawn(options.cliPath, [...args, "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            child.kill("SIGTERM");
            reject(new Error(`iMessage action timed out after ${options.timeoutMs}ms`));
          }, options.timeoutMs)
        : null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (timer) {
        clearTimeout(timer);
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      const lines = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const last = lines.at(-1);
      let parsed: Record<string, unknown> | null = null;
      if (last) {
        try {
          const value = JSON.parse(last);
          if (value && typeof value === "object" && !Array.isArray(value)) {
            parsed = value as Record<string, unknown>;
          }
        } catch {
          parsed = null;
        }
      }
      if (code !== 0) {
        const detail =
          (typeof parsed?.error === "string" && parsed.error.trim()) ||
          stderr.trim() ||
          stdout.trim() ||
          `imsg exited with code ${code}`;
        reject(new Error(detail));
        return;
      }
      if (!parsed) {
        reject(new Error(`imsg returned non-JSON output: ${stdout.trim() || stderr.trim()}`));
        return;
      }
      if (parsed.success === false) {
        const error =
          typeof parsed.error === "string" && parsed.error.trim()
            ? parsed.error.trim()
            : "iMessage action failed";
        reject(new Error(error));
        return;
      }
      resolve(parsed);
    });
  });
}

function resolveMessageId(result: Record<string, unknown>): string {
  const raw =
    (typeof result.messageGuid === "string" && result.messageGuid.trim()) ||
    (typeof result.messageId === "string" && result.messageId.trim()) ||
    (typeof result.guid === "string" && result.guid.trim()) ||
    (typeof result.id === "string" && result.id.trim());
  return raw || "ok";
}

async function withTempFile<T>(input: TempFileInput, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-imessage-"));
  const safeExt = extname(input.filename).slice(0, 16) || ".bin";
  const filePath = join(dir, `upload${safeExt}`);
  try {
    await writeFile(filePath, input.buffer);
    return await fn(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const imessageActionsRuntime = {
  async sendReaction(params: {
    chatGuid: string;
    messageId: string;
    reaction: string;
    remove?: boolean;
    partIndex?: number;
    options: IMessageBridgeActionOptions;
  }) {
    await runIMessageCliJson(
      [
        "tapback",
        "--chat",
        params.chatGuid,
        "--message",
        params.messageId,
        "--kind",
        params.reaction,
        "--part",
        String(params.partIndex ?? 0),
        ...(params.remove ? ["--remove"] : []),
      ],
      params.options,
    );
  },

  async editMessage(params: {
    chatGuid: string;
    messageId: string;
    text: string;
    backwardsCompatMessage?: string;
    partIndex?: number;
    options: IMessageBridgeActionOptions;
  }) {
    await runIMessageCliJson(
      [
        "edit",
        "--chat",
        params.chatGuid,
        "--message",
        params.messageId,
        "--new-text",
        params.text,
        "--bc-text",
        params.backwardsCompatMessage ?? params.text,
        "--part",
        String(params.partIndex ?? 0),
      ],
      params.options,
    );
  },

  async unsendMessage(params: {
    chatGuid: string;
    messageId: string;
    partIndex?: number;
    options: IMessageBridgeActionOptions;
  }) {
    await runIMessageCliJson(
      [
        "unsend",
        "--chat",
        params.chatGuid,
        "--message",
        params.messageId,
        "--part",
        String(params.partIndex ?? 0),
      ],
      params.options,
    );
  },

  async sendRichMessage(params: {
    chatGuid: string;
    text: string;
    effectId?: string;
    replyToMessageId?: string;
    partIndex?: number;
    options: IMessageBridgeActionOptions;
  }): Promise<IMessageBridgeSendResult> {
    const result = await runIMessageCliJson(
      [
        "send-rich",
        "--chat",
        params.chatGuid,
        "--text",
        params.text,
        "--part",
        String(params.partIndex ?? 0),
        ...(params.effectId ? ["--effect", params.effectId] : []),
        ...(params.replyToMessageId ? ["--reply-to", params.replyToMessageId] : []),
      ],
      params.options,
    );
    return { messageId: resolveMessageId(result) };
  },

  async renameGroup(params: {
    chatGuid: string;
    displayName: string;
    options: IMessageBridgeActionOptions;
  }) {
    await runIMessageCliJson(
      ["chat-name", "--chat", params.chatGuid, "--name", params.displayName],
      params.options,
    );
  },

  async setGroupIcon(params: {
    chatGuid: string;
    buffer: Uint8Array;
    filename: string;
    options: IMessageBridgeActionOptions;
  }) {
    await withTempFile({ buffer: params.buffer, filename: params.filename }, async (filePath) => {
      await runIMessageCliJson(
        ["chat-photo", "--chat", params.chatGuid, "--file", filePath],
        params.options,
      );
    });
  },

  async addParticipant(params: {
    chatGuid: string;
    address: string;
    options: IMessageBridgeActionOptions;
  }) {
    await runIMessageCliJson(
      ["chat-add-member", "--chat", params.chatGuid, "--address", params.address],
      params.options,
    );
  },

  async removeParticipant(params: {
    chatGuid: string;
    address: string;
    options: IMessageBridgeActionOptions;
  }) {
    await runIMessageCliJson(
      ["chat-remove-member", "--chat", params.chatGuid, "--address", params.address],
      params.options,
    );
  },

  async leaveGroup(params: { chatGuid: string; options: IMessageBridgeActionOptions }) {
    await runIMessageCliJson(["chat-leave", "--chat", params.chatGuid], params.options);
  },

  async sendAttachment(params: {
    chatGuid: string;
    buffer: Uint8Array;
    filename: string;
    asVoice?: boolean;
    options: IMessageBridgeActionOptions;
  }): Promise<IMessageBridgeSendResult> {
    return await withTempFile(
      { buffer: params.buffer, filename: params.filename },
      async (filePath) => {
        const result = await runIMessageCliJson(
          [
            "send-attachment",
            "--chat",
            params.chatGuid,
            "--file",
            filePath,
            ...(params.asVoice ? ["--audio"] : []),
          ],
          params.options,
        );
        return { messageId: resolveMessageId(result) };
      },
    );
  },
};

export type IMessageActionsRuntime = typeof imessageActionsRuntime;
