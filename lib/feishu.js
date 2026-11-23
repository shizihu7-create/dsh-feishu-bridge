/**
 * Thin wrapper over the official Feishu Node SDK: one long-lived WebSocket
 * connection in, REST calls out. Nothing here knows about DSH.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Loaded lazily so a missing/broken dependency surfaces as a readable status, not a boot failure. */
function loadSdk() {
  const sdk = require('@larksuiteoapi/node-sdk');
  return sdk.default ?? sdk;
}

/** Raised for an SDK-level refusal, keeping Feishu's code for diagnostics. */
export class FeishuError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'FeishuError';
    this.code = code;
  }
}

/** Unwrap one SDK response: `code !== 0` is an API refusal, not a transport failure. */
function unwrap(response, action) {
  if (response === undefined || response === null) {
    throw new FeishuError(`${action}: empty response`, undefined);
  }
  const code = response.code ?? 0;
  if (code !== 0) {
    throw new FeishuError(`${action} failed: ${response.msg ?? 'unknown error'} (code ${code})`, code);
  }
  return response.data ?? {};
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** One Feishu application: connection state plus outbound message helpers. */
export class FeishuTransport {
  constructor({ appId, appSecret, logger, onMessage, onCardAction }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.logger = logger;
    this.onMessage = onMessage;
    this.onCardAction = onCardAction;
    this.sdk = loadSdk();
    this.client = new this.sdk.Client({
      appId,
      appSecret,
      loggerLevel: this.sdk.LoggerLevel?.error ?? 3,
    });
    this.ws = undefined;
    this.state = 'idle';
    this.lastError = undefined;
    this.connectedAt = undefined;
    this.bot = undefined;
  }

  /** Open the long connection. Resolves once the socket reports ready or a failure is known. */
  async start() {
    if (this.ws !== undefined) return;
    const sdk = this.sdk;
    const dispatcher = new sdk.EventDispatcher({}).register({
      'im.message.receive_v1': (event) => {
        // The platform retries when the handler takes longer than 3 s, so hand off
        // and answer immediately; ordering is restored inside the bridge.
        void Promise.resolve().then(() => this.onMessage(event)).catch((error) => {
          this.logger?.warn?.(`feishu-bridge: inbound message failed: ${String(error)}`);
        });
        return {};
      },
      'card.action.trigger': (event) => {
        try {
          return this.onCardAction(event) ?? {};
        } catch (error) {
          this.logger?.warn?.(`feishu-bridge: card action failed: ${String(error)}`);
          return {};
        }
      },
    });

    this.state = 'connecting';
    this.ws = new sdk.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      loggerLevel: sdk.LoggerLevel?.warn ?? 2,
      autoReconnect: true,
      onReady: () => {
        this.state = 'ready';
        this.connectedAt = Date.now();
        this.lastError = undefined;
        this.logger?.info?.('feishu-bridge: long connection ready');
      },
      onError: (error) => {
        this.state = 'error';
        this.lastError = error instanceof Error ? error.message : String(error);
        this.logger?.warn?.(`feishu-bridge: long connection error: ${this.lastError}`);
      },
      onReconnecting: () => {
        this.state = 'reconnecting';
      },
      onReconnected: () => {
        this.state = 'ready';
      },
    });
    this.ws.start({ eventDispatcher: dispatcher });
    // WSClient.start reconnects on its own; give the handshake a moment so status
    // reporting is meaningful without turning a slow network into a failure.
    for (let attempt = 0; attempt < 50 && this.state === 'connecting'; attempt += 1) await sleep(100);
    try {
      const identity = await this.fetchBotIdentity();
      this.bot = identity;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger?.warn?.(`feishu-bridge: cannot read bot identity: ${this.lastError}`);
    }
  }

  /** Close the socket; safe to call twice. */
  stop() {
    try {
      this.ws?.close();
    } catch (error) {
      this.logger?.warn?.(`feishu-bridge: closing the long connection failed: ${String(error)}`);
    }
    this.ws = undefined;
    this.state = 'stopped';
  }

  /** Connection facts for `/status`. */
  describe() {
    let socketState;
    try {
      socketState = this.ws?.getConnectionStatus?.();
    } catch {
      socketState = undefined;
    }
    return {
      state: this.state,
      connectedAt: this.connectedAt,
      lastError: this.lastError,
      bot: this.bot,
      socketState,
    };
  }

  /** The bot's own identity, used to detect @-mentions in groups. */
  async fetchBotIdentity() {
    const response = await this.client.request({ method: 'GET', url: '/open-apis/bot/v3/info' });
    if (response?.code !== 0) {
      throw new FeishuError(`bot identity failed: ${response?.msg ?? 'unknown error'} (code ${response?.code})`, response?.code);
    }
    return response.bot ?? {};
  }

  /** Create one message in a chat and return its id. */
  async #create(chatId, msgType, content) {
    const response = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: msgType, content },
    });
    return unwrap(response, `send ${msgType}`).message_id;
  }

  /** Reply inside the topic of a user message; falls back to a new chat message when reply is refused. */
  async #reply(messageId, chatId, msgType, content) {
    if (messageId) {
      try {
        const response = await this.client.im.message.reply({
          path: { message_id: messageId },
          data: { msg_type: msgType, content },
        });
        return unwrap(response, `reply ${msgType}`).message_id;
      } catch (error) {
        this.logger?.warn?.(`feishu-bridge: reply refused, sending instead: ${String(error)}`);
      }
    }
    return this.#create(chatId, msgType, content);
  }

  /** Send an interactive card to a chat. */
  sendCard(chatId, card) {
    return this.#create(chatId, 'interactive', JSON.stringify(card));
  }

  /** Send an interactive card as a reply, so a group thread stays readable. */
  replyCard(messageId, chatId, card) {
    return this.#reply(messageId, chatId, 'interactive', JSON.stringify(card));
  }

  /** Send plain text to a chat. */
  sendText(chatId, text) {
    return this.#create(chatId, 'text', JSON.stringify({ text }));
  }

  /** Send plain text as a reply. */
  replyText(messageId, chatId, text) {
    return this.#reply(messageId, chatId, 'text', JSON.stringify({ text }));
  }

  /**
   * Download one resource attached to a received message.
   * Only the message-resource API can read resources the bot did not upload.
   */
  async downloadResource(messageId, fileKey, type) {
    let response;
    try {
      response = await this.client.im.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type },
      });
    } catch (error) {
      // The SDK throws on a non-2xx answer; keep Feishu's code for actionable hints.
      const body = error?.response?.data;
      throw new FeishuError(body?.msg ?? error?.message ?? String(error), body?.code);
    }
    if (typeof response?.getReadableStream !== 'function') {
      // A refusal can also arrive as JSON instead of a byte stream.
      throw new FeishuError(
        `download ${type} failed: ${response?.msg ?? 'no stream in response'} (code ${response?.code ?? '?'})`,
        response?.code,
      );
    }
    const chunks = [];
    for await (const chunk of response.getReadableStream()) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  /** Upload one workspace file so a later message can carry it. Feishu caps uploads at 30 MB. */
  async uploadFile(name, bytes) {
    let response;
    try {
      response = await this.client.im.file.create({
        data: { file_type: 'stream', file_name: name, file: bytes },
      });
    } catch (error) {
      const body = error?.response?.data;
      throw new FeishuError(body?.msg ?? error?.message ?? String(error), body?.code);
    }
    // This endpoint answers `{ file_key }` at the top level, unlike the usual
    // `{ code, msg, data }` envelope, so read both shapes.
    const fileKey = response?.data?.file_key ?? response?.file_key;
    if (typeof fileKey !== 'string' || fileKey === '') {
      throw new FeishuError(`upload file failed: ${response?.msg ?? 'no file_key in response'}`, response?.code);
    }
    return fileKey;
  }

  /** Deliver an uploaded file as a reply, so it threads under the request. */
  replyFile(messageId, chatId, fileKey) {
    return this.#reply(messageId, chatId, 'file', JSON.stringify({ file_key: fileKey }));
  }

  /** Deliver an uploaded file as a new message in the chat. */
  sendFile(chatId, fileKey) {
    return this.#create(chatId, 'file', JSON.stringify({ file_key: fileKey }));
  }

  /** Replace an existing card's content. Feishu allows 5 updates per second per message. */
  async patchCard(messageId, card) {    const body = JSON.stringify(card);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.client.im.message.patch({
          path: { message_id: messageId },
          data: { content: body },
        });
        unwrap(response, 'update card');
        return;
      } catch (error) {
        // 230020 is the documented per-message frequency limiter.
        if (error instanceof FeishuError && error.code === 230020 && attempt === 0) {
          await sleep(700);
          continue;
        }
        throw error;
      }
    }
  }
}
