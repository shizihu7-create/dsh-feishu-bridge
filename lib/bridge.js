/**
 * The DSH side of the bridge: Feishu chats ⇄ Sessions.
 *
 * Inbound:  @bot text → sessionController.prompt() on the chat's bound session.
 * Outbound: session/event + agent/assistant-stream → one throttled progress card.
 * Control:  approval/request and user-questions/request, owned only for bound
 *           sessions; every other request is delegated with next() to the desktop UI.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readWorkspaceFile, saveUpload, sniffImageMediaType } from './attachments.js';
import * as cards from './cards.js';
import { FeishuTransport } from './feishu.js';
import { Store } from './state.js';

const HELP = [
  '**可用命令**',
  '- `/new` 新建会话',
  '- `/ls` 最近会话',
  '- `/use <序号>` 切到某个会话',
  '- `/stop` 中断当前回合',
  '- `/status` 连接与绑定状态',
  '- `/model` 查看模型，`/model <序号>` 切换',
  '- `/send <路径>` 把工作区里的文件发回手机',
  '',
  '直接发消息即可对话；需要授权时会推送审批卡片。',
].join('\n');

/** Concatenate the text blocks of a message or content array. */
function blocksText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim();
}

/** Split long text into message-sized pieces on paragraph boundaries. */
function chunkText(text, size) {
  const pieces = [];
  let rest = text;
  while (rest.length > size) {
    const window = rest.slice(0, size);
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf('。'));
    const at = cut > size * 0.5 ? cut + 1 : size;
    pieces.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  if (rest !== '') pieces.push(rest);
  return pieces;
}

/**
 * Read one Feishu rich-text (`post`) message: paragraph text plus the image and
 * media keys it carries, so a "text + picture" message is one prompt, not a refusal.
 */
export function parsePost(message) {
  let parsed;
  try {
    parsed = JSON.parse(message?.content ?? '{}');
  } catch {
    return { text: '', images: [], files: [] };
  }
  const lines = [];
  const images = [];
  const files = [];
  if (typeof parsed.title === 'string' && parsed.title.trim() !== '') lines.push(parsed.title.trim());
  for (const row of Array.isArray(parsed.content) ? parsed.content : []) {
    const segments = [];
    for (const node of Array.isArray(row) ? row : []) {
      if (node === null || typeof node !== 'object') continue;
      if (node.tag === 'text' || node.tag === 'a') segments.push(String(node.text ?? node.href ?? ''));
      else if (node.tag === 'img' && typeof node.image_key === 'string') images.push(node.image_key);
      else if (node.tag === 'media' && typeof node.file_key === 'string') {
        files.push({ key: node.file_key, name: String(node.file_name ?? 'feishu-media') });
      }
    }
    if (segments.join('').trim() !== '') lines.push(segments.join(''));
  }
  return { text: lines.join('\n').trim(), images, files };
}

/** A short, human-usable label for a session row. */
function sessionLabel(summary) {  const title = summary?.projections?.values?.title;
  const id = String(summary?.sessionId ?? '');
  const cwd = typeof summary?.cwd === 'string' ? summary.cwd.split(/[\\/]/).filter(Boolean).pop() : undefined;
  const head = typeof title === 'string' && title.trim() !== '' ? title.trim() : `${id.slice(0, 12)}…`;
  return cwd ? `${head} (${cwd})` : head;
}

/** The bridge plugin body. */
export class FeishuBridge {
  constructor(ctx) {
    this.ctx = ctx;
    this.logger = ctx.logger;
    this.store = new Store(ctx.logger);
    this.transport = undefined;
    this.disposers = [];
    /** chatId → { sessionId, chatType } */
    this.chats = new Map();
    /**
     * sessionId → ordered turn states. The first entry owns the session's live
     * stream and card; later entries are queued prompts waiting for their turn,
     * so two messages to one session never overwrite each other's card.
     */
    this.active = new Map();
    /** chatId → in-flight session creation, so concurrent messages create one session */
    this.sessionCreations = new Map();
    /** sessionId → { value, at } card title cache */
    this.sessionLabels = new Map();
    /** sessionId → card id recorded before a reload that left the turn running */
    this.readopted = new Map();
    /** request id → pending approval */
    this.approvals = new Map();
    /** request id → pending question */
    this.questions = new Map();
    /** chatId → last `/ls` result, so `/use <n>` can address it */
    this.listings = new Map();
    this.stopped = false;
  }

  /** Load state, wire the Host events, and connect when credentials are present. */
  async start() {
    this.store.load();
    // Touch the state file so a fresh install has a durable home and a
    // visible proof that the plugin body actually ran.
    this.store.save();
    for (const [chatId, binding] of Object.entries(this.store.data.bindings)) {
      if (binding?.sessionId) this.chats.set(chatId, { sessionId: binding.sessionId, chatType: binding.chatType });
    }
    this.registerHostEvents();
    this.registerCommands();
    this.store.data.runtime = {
      startedAt: Date.now(),
      listeners: this.disposers.length,
      commands: this.commandsRegistered === true,
      transport: 'idle',
    };
    this.store.save();
    if (this.store.data.appId) {
      try {
        await this.connect();
      } catch (error) {
        this.lastConnectError = error instanceof Error ? error.message : String(error);
        this.logger?.warn?.(`feishu-bridge: connection not established: ${this.lastConnectError}`);
      }
    }
    await this.settleStaleCards();
  }

  /** Register the DSH events this bridge consumes. */
  registerHostEvents() {
    const on = (name, listener, options) => {
      const dispose = this.ctx.on(name, listener, options);
      if (typeof dispose === 'function') this.disposers.push(dispose);
    };
    on('session/event', (session, event) => {
      try {
        this.onSessionEvent(session, event);
      } catch (error) {
        this.logger?.warn?.(`feishu-bridge: session event handling failed: ${String(error)}`);
      }
    });
    on('agent/assistant-stream', (payload) => {
      try {
        this.onAssistantStream(payload);
      } catch (error) {
        this.logger?.warn?.(`feishu-bridge: stream handling failed: ${String(error)}`);
      }
    });
    // Registered ahead of the desktop UI's answerer so a bound session's approval
    // reaches the phone; every other request falls through with next().
    on('approval/request', (request, next) => this.handleApproval(request, next), { prepend: true });
    on('user-questions/request', (request, next) => this.handleQuestion(request, next), { prepend: true });
  }

  /** Register the desktop-side slash command used for setup and diagnostics. */
  registerCommands() {
    const commands = this.ctx.get('commands');
    if (!commands?.register) {
      this.logger?.warn?.('feishu-bridge: commands service unavailable; /feishu setup will not work');
      return;
    }
    const dispose = commands.register({
      name: 'feishu',
      description: '飞书机器人：setup <AppID> <AppSecret> / status / disconnect / reset',
      input: { hint: 'setup <AppID> <AppSecret> | status | disconnect | reset' },
      handler: async ({ rawInput }) => this.onDesktopCommand(rawInput ?? ''),
    });
    this.commandsRegistered = true;
    if (typeof dispose === 'function') this.disposers.push(dispose);
  }

  /** `/feishu …` executed in the desktop composer. */
  async onDesktopCommand(rawInput) {
    const [action, ...rest] = String(rawInput).trim().split(/\s+/).filter(Boolean);
    try {
      if (action === undefined || action === 'status') {
        return { kind: 'success', text: this.statusText() };
      }
      if (action === 'setup') {
        const [appId, appSecret] = rest;
        if (!appId || !appSecret) return { kind: 'error', text: '用法：/feishu setup <AppID> <AppSecret>' };
        const stored = await this.saveCredentials(appId, appSecret);
        // Bound the wait: a slow handshake must not stall the composer, and the
        // connection keeps going in the background either way.
        const connecting = this.connect();
        const outcome = await Promise.race([
          connecting.then(transport => ({ state: transport.state })),
          new Promise((resolve) => { setTimeout(() => { resolve({ pending: true }); }, 6000); }),
        ]);
        return {
          kind: 'success',
          text: [
            `凭据已保存到${stored ? ' DSH credentials 记录' : '插件状态文件（credentials 服务不可用）'}。`,
            outcome.pending === true ? '连接仍在建立，稍后执行 /feishu status 查看结果。' : `长连接状态：${outcome.state}。`,
            '',
            this.statusText(),
          ].join('\n'),
        };
      }
      if (action === 'disconnect') {
        this.transport?.stop();
        this.transport = undefined;
        return { kind: 'success', text: '长连接已断开，凭据保留。执行 /feishu setup 可重连。' };
      }
      if (action === 'reset') {
        this.store.resetOwners();
        return { kind: 'success', text: '已清空管理员名单：下一个在飞书里 @ 机器人的人将成为管理员。' };
      }
      return { kind: 'error', text: '未知子命令。用法：/feishu [setup|status|disconnect|reset]' };
    } catch (error) {
      return { kind: 'error', text: `飞书命令失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /** Human-readable connection summary. */
  statusText() {
    const transport = this.transport?.describe();
    const lines = [
      `**飞书机器人**`,
      `- App ID：${this.store.data.appId || '未配置'}`,
      `- 长连接：${transport ? `${transport.state}${transport.lastError ? `（${transport.lastError}）` : ''}` : '未启动'}`,
      ...(transport || this.lastConnectError === undefined ? [] : [`- 上次失败：${this.lastConnectError}`]),
      `- 机器人：${transport?.bot?.app_name ?? '-'}`,
      `- 管理员：${this.store.data.ownerOpenIds.length} 人`,
      `- 已绑定会话：${this.chats.size} 个群`,
    ];
    return lines.join('\n');
  }

  /** Store the app secret in DSH credentials when possible, else in the state file. */
  async saveCredentials(appId, appSecret) {
    const credentials = this.ctx.get('credentials');
    let stored = false;
    if (credentials?.modifyRecord) {
      try {
        await credentials.modifyRecord('feishu-bridge/auth', async () => ({
          kind: 'grant',
          payload: { appId, appSecret },
        }));
        // Verify the record really round-trips; an unusable record must not lose the secret.
        const record = await credentials.readRecord('feishu-bridge/auth');
        stored = record?.payload?.appSecret === appSecret;
      } catch (error) {
        this.logger?.warn?.(`feishu-bridge: credentials record rejected, using the state file: ${String(error)}`);
        stored = false;
      }
    }
    this.store.data.appId = appId;
    if (stored) delete this.store.data.appSecret;
    else this.store.data.appSecret = appSecret;
    this.store.save();
    return stored;
  }

  /** Read the app secret back from wherever it was stored. */
  async loadSecret() {
    const credentials = this.ctx.get('credentials');
    if (credentials?.readRecord) {
      try {
        const record = await credentials.readRecord('feishu-bridge/auth');
        const secret = record?.payload?.appSecret;
        if (typeof secret === 'string' && secret !== '') return secret;
      } catch (error) {
        this.logger?.warn?.(`feishu-bridge: reading the credentials record failed: ${String(error)}`);
      }
    }
    return typeof this.store.data.appSecret === 'string' ? this.store.data.appSecret : '';
  }

  /** (Re)open the long connection. */
  async connect() {
    if (!this.store.data.appId) throw new Error('还没有 App ID：先执行 /feishu setup <AppID> <AppSecret>');
    const appSecret = await this.loadSecret();
    if (!appSecret) throw new Error('没有读到 App Secret，请重新执行 /feishu setup');
    this.transport?.stop();
    const transport = new FeishuTransport({
      appId: this.store.data.appId,
      appSecret,
      logger: this.logger,
      onMessage: (event) => this.onInbound(event),
      onCardAction: (event) => this.onCardAction(event),
    });
    this.transport = transport;
    await transport.start();
    this.store.data.lastConnectedAt = Date.now();
    const described = transport.describe();
    this.store.data.runtime = {
      ...(this.store.data.runtime ?? {}),
      transport: described.state,
      lastError: described.lastError,
      bot: described.bot?.app_name,
      appId: this.store.data.appId,
    };
    this.store.save();
    return described;
  }

  // ---------------------------------------------------------------- inbound

  /** One `im.message.receive_v1` event. */
  async onInbound(event) {
    const message = event?.message;
    const sender = event?.sender;
    if (!message?.message_id || !message?.chat_id) return;
    if (sender?.sender_type === 'app' || sender?.sender_type === 'bot') return;
    const openId = sender?.sender_id?.open_id;
    const chatId = message.chat_id;
    const chatType = message.chat_type === 'p2p' ? 'p2p' : 'group';

    if (!this.store.markSeen(message.message_id)) return;

    if (!this.store.isOwner(openId)) {
      if (this.store.data.ownerOpenIds.length === 0 && this.store.claimOwner(openId)) {
        await this.safeReply(message, cards.infoCard({
          title: 'DSH · 已配对',
          template: 'green',
          body: '你已成为这台机器人的管理员。\n\n直接发消息开始对话，或发送 `/help` 查看命令。',
        }));
        return;
      }
      if (chatType === 'p2p') {
        await this.safeReply(message, cards.infoCard({
          title: 'DSH · 无权限',
          template: 'grey',
          body: '这台机器人已绑定其他管理员。需要在桌面端执行 `/feishu reset` 重置。',
        }));
      }
      return;
    }

    const text = this.extractText(message);
    if (chatType === 'group') {
      const botOpenId = this.transport?.bot?.open_id;
      const mentions = message.mentions ?? [];
      if (botOpenId !== undefined) {
        if (!mentions.some(mention => mention?.id?.open_id === botOpenId)) return;
      } else if (mentions.length === 0) {
        // Without the bot's own identity only an explicit mention can address it.
        return;
      }
    }
    if (message.message_type !== 'text') {
      await this.handleAttachment(message, chatId, chatType);
      return;
    }

    // A pending approval accepts a typed verdict as the documented fallback.
    if (this.consumeTypedVerdict(chatId, text)) return;
    // A pending question accepts a typed option label or free text.
    if (!text.startsWith('/') && this.consumeTypedAnswer(chatId, text)) return;

    if (text.startsWith('/')) {
      await this.onChatCommand(message, chatId, chatType, text);
      return;
    }
    if (text === '') {
      await this.safeReply(message, cards.infoCard({ title: 'DSH', body: HELP }));
      return;
    }
    await this.deliver(message, chatId, chatType, text);
  }

  /** Strip mention placeholders and return the plain body. */
  extractText(message) {
    let parsed;
    try {
      parsed = JSON.parse(message.content ?? '{}');
    } catch {
      return '';
    }
    let text = typeof parsed.text === 'string' ? parsed.text : '';
    for (const mention of message.mentions ?? []) {
      if (typeof mention?.key === 'string') text = text.split(mention.key).join('');
    }
    return text.trim();
  }

  /** Send one prompt and start its progress card. */
  async deliver(message, chatId, chatType, text, parts) {
    const sessionController = this.ctx.get('sessionController');
    if (!sessionController?.prompt) {
      await this.safeReply(message, cards.infoCard({ title: 'DSH · 不可用', template: 'red', body: '当前部署没有 session 控制器，无法投递消息。' }));
      return;
    }
    let sessionId;
    try {
      sessionId = await this.ensureSession(chatId, chatType);
    } catch (error) {
      await this.safeReply(message, cards.infoCard({ title: 'DSH · 建会话失败', template: 'red', body: String(error?.message ?? error) }));
      return;
    }

    const state = this.newTurnState(chatId, chatType, sessionId, text);
    state.messageId = message.message_id;
    state.label = await this.labelOf(sessionId);
    const isHead = this.enqueue(state);
    state.queued = !isHead;
    try {
      state.cardId = await this.transport.replyCard(
        message.message_id,
        chatId,
        cards.progressCard({
          quote: state.quote,
          text: '',
          tools: [],
          label: state.label,
          status: state.queued ? '排队中…' : '处理中…',
          stopSession: state.queued ? undefined : sessionId,
          note: state.queued ? '这条会等上一轮结束' : '已交给 DSH',
        }),
      );
      if (state.cardId !== undefined) {
        this.store.addInflight({
          cardId: state.cardId,
          chatId,
          sessionId,
          quote: state.quote,
          startedAt: state.startedAt,
        });
      }
    } catch (error) {
      this.logger?.warn?.(`feishu-bridge: cannot open the progress card: ${String(error)}`);
    }
    state.timer = setInterval(() => { void this.flush(state); }, this.store.settings.flushIntervalMs);

    try {
      await sessionController.prompt({
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: parts ?? [{ type: 'text', text }],
        clientTimeZone: 'Asia/Shanghai',
      }, AbortSignal.timeout(30_000));
    } catch (error) {
      state.failed = `投递失败：${error?.message ?? error}`;
      await this.finish(state);
    }
  }

  /**
   * One image or file message from the phone.
   * Images enter the prompt as attachment parts; files are saved inside the
   * session's working directory so the agent's own tools can read them.
   */
  async handleAttachment(message, chatId, chatType) {
    const type = message.message_type;
    if (type === 'post') {
      await this.handlePost(message, chatId, chatType);
      return;
    }
    if (type !== 'image' && type !== 'file') {
      await this.safeReply(message, cards.infoCard({
        title: 'DSH · 不支持',
        template: 'orange',
        body: `暂时只接收文字、图片和文件；这条是 \`${type}\`。`,
      }));
      return;
    }
    let parsed = {};
    try {
      parsed = JSON.parse(message.content ?? '{}');
    } catch {
      parsed = {};
    }
    const key = type === 'image' ? parsed.image_key : parsed.file_key;
    if (typeof key !== 'string' || key === '') {
      await this.safeReply(message, cards.infoCard({ title: 'DSH · 附件缺失', template: 'red', body: '消息里没有可下载的资源 key。' }));
      return;
    }
    const settings = this.store.settings;
    const limit = type === 'image' ? settings.maxImageBytes : settings.maxFileBytes;

    let bytes;
    try {
      bytes = await this.transport.downloadResource(message.message_id, key, type);
    } catch (error) {
      await this.safeReply(message, cards.infoCard({
        title: 'DSH · 下载失败',
        template: 'red',
        body: this.attachmentFailureHint(error, type),
      }));
      return;
    }
    if (bytes.length > limit) {
      const limitMb = Math.round(limit / (1024 * 1024));
      await this.safeReply(message, cards.infoCard({
        title: 'DSH · 太大',
        template: 'orange',
        body: `这个${type === 'image' ? '图片' : '文件'}有 ${(bytes.length / (1024 * 1024)).toFixed(1)} MB，超过上限 ${limitMb} MB。`,
      }));
      return;
    }

    if (type === 'image') {
      const mediaType = sniffImageMediaType(bytes);
      if (mediaType === undefined) {
        await this.safeReply(message, cards.infoCard({
          title: 'DSH · 图片格式不支持',
          template: 'orange',
          body: '只认 PNG、JPEG、WebP、GIF。',
        }));
        return;
      }
      await this.deliver(message, chatId, chatType, '📷 图片', [
        { type: 'text', text: '（用户从手机发来一张图片）' },
        { type: 'image', mediaType, data: bytes.toString('base64'), name: `${Date.now()}.${mediaType.split('/')[1]}` },
      ]);
      return;
    }

    let sessionId;
    let cwd;
    try {
      sessionId = await this.ensureSession(chatId, chatType);
      cwd = await this.sessionCwd(sessionId);
    } catch (error) {
      await this.safeReply(message, cards.infoCard({ title: 'DSH · 建会话失败', template: 'red', body: String(error?.message ?? error) }));
      return;
    }
    if (cwd === undefined) {
      await this.safeReply(message, cards.infoCard({ title: 'DSH · 没有工作目录', template: 'red', body: '无法确定这个会话的工作目录，文件没有保存。' }));
      return;
    }
    let saved;
    try {
      saved = await saveUpload(cwd, parsed.file_name ?? 'feishu-file', bytes);
    } catch (error) {
      await this.safeReply(message, cards.infoCard({ title: 'DSH · 保存失败', template: 'red', body: String(error?.message ?? error) }));
      return;
    }
    await this.deliver(message, chatId, chatType, `📎 ${saved.name}`, [{
      type: 'text',
      text: `[飞书文件] ${saved.name} 已保存到 ${saved.path}（${(saved.bytes / 1024).toFixed(1)} KB），请按需读取。`,
    }]);
  }

  /**
   * One rich-text message: paragraph text, images and media in a single prompt.
   * A resource that cannot be fetched becomes a note instead of failing the batch.
   */
  async handlePost(message, chatId, chatType) {
    const { text, images, files } = parsePost(message);
    const settings = this.store.settings;
    const parts = [];
    const notes = [];
    if (text !== '') parts.push({ type: 'text', text });
    for (const [index, imageKey] of images.entries()) {
      const limitMb = Math.round(settings.maxImageBytes / (1024 * 1024));
      try {
        const bytes = await this.transport.downloadResource(message.message_id, imageKey, 'image');
        if (bytes.length > settings.maxImageBytes) {
          notes.push(`一张图片超过 ${limitMb} MB，已跳过`);
          continue;
        }
        const mediaType = sniffImageMediaType(bytes);
        if (mediaType === undefined) {
          notes.push('一张图片格式不支持（只认 PNG/JPEG/WebP/GIF），已跳过');
          continue;
        }
        parts.push({
          type: 'image',
          mediaType,
          data: bytes.toString('base64'),
          name: `${Date.now()}-${index}.${mediaType.split('/')[1]}`,
        });
      } catch (error) {
        notes.push(`一张图片下载失败：${error?.message ?? error}`);
      }
    }
    for (const entry of files) {
      const limitMb = Math.round(settings.maxFileBytes / (1024 * 1024));
      try {
        const bytes = await this.transport.downloadResource(message.message_id, entry.key, 'file');
        if (bytes.length > settings.maxFileBytes) {
          notes.push(`文件 ${entry.name} 超过 ${limitMb} MB，已跳过`);
          continue;
        }
        const cwd = await this.sessionCwd(await this.ensureSession(chatId, chatType));
        if (cwd === undefined) {
          notes.push(`没有工作目录，${entry.name} 未保存`);
          continue;
        }
        const saved = await saveUpload(cwd, entry.name, bytes);
        parts.push({
          type: 'text',
          text: `[飞书文件] ${saved.name} 已保存到 ${saved.path}（${(saved.bytes / 1024).toFixed(1)} KB）`,
        });
      } catch (error) {
        notes.push(`文件 ${entry.name} 保存失败：${error?.message ?? error}`);
      }
    }
    if (notes.length > 0) parts.push({ type: 'text', text: `（附件提示）${notes.join('；')}` });
    if (parts.length === 0) {
      await this.safeReply(message, cards.infoCard({
        title: 'DSH · 空消息',
        template: 'orange',
        body: '这条图文消息里没有可用的文字或附件。',
      }));
      return;
    }
    const quote = text !== ''
      ? text
      : images.length > 0
        ? '📷 图文消息'
        : '📎 文件消息';
    await this.deliver(message, chatId, chatType, quote, parts);
  }

  /** Turn an upload refusal into an actionable sentence. */
  deliveryFailureHint(error) {
    const code = error?.code;
    if (code === 99991672) {
      return [
        '无法发送文件：**缺少上传权限**。',
        '',
        '在开放平台「权限管理」开通 `im:resource:upload`（或 `im:resource`），',
        '然后**创建版本并发布**才生效。',
        '',
        `原始错误：${error?.message ?? error}`,
      ].join('\n');
    }
    if (code === 234006) return '文件超过飞书上限（单个文件 30 MB）。';
    return `上传失败：${error?.message ?? error}`;
  }

  /** Turn a download refusal into an actionable sentence. */
  attachmentFailureHint(error, type) {
    const code = error?.code;
    const what = type === 'image' ? '图片' : '文件';
    const detail = `原始错误：${error?.message ?? error}`;
    if (code === 99991672) {
      return [
        `无法下载${what}：**缺少权限**。`,
        '',
        '在开放平台「权限管理」里开通任意一个（建议第一个，权限更小）：',
        '- `im:message:readonly` 获取单聊、群组消息',
        '- `im:message` 获取与发送单聊、群组消息',
        '',
        '开通后要**创建版本并发布**才生效。',
        '',
        detail,
      ].join('\n');
    }
    if (code === 234004) return `无法下载${what}：应用不在这个消息所在的会话里。\n\n${detail}`;
    if (code === 234003) return `无法下载${what}：资源与消息不匹配（可能是重复事件）。\n\n${detail}`;
    if (code === 234038) return `无法下载${what}：这是保密消息，或群开启了防泄密模式。\n\n${detail}`;
    if (code === 230110) return `无法下载${what}：消息已被撤回或删除。\n\n${detail}`;
    return `无法下载${what}：${detail}`;
  }

  /** The bound session's working directory, used to place uploads where its tools can read them. */
  async sessionCwd(sessionId) {
    const live = this.ctx.get('agents')?.get?.(sessionId);
    const liveCwd = live?.session?.header?.cwd;
    if (typeof liveCwd === 'string' && liveCwd !== '') return liveCwd;
    try {
      const listing = await this.ctx.get('sessionController')?.list?.({}, AbortSignal.timeout(10_000));
      const row = (listing?.items ?? []).find(item => item.sessionId === sessionId);
      if (typeof row?.cwd === 'string' && row.cwd !== '') return row.cwd;
    } catch (error) {
      this.logger?.warn?.(`feishu-bridge: cannot read the session cwd: ${String(error)}`);
    }
    const workspaces = this.ctx.get('workspaceRegistry')?.list?.() ?? [];
    const preferred = workspaces.find(entry => entry.path === this.ctx.get('workingDirectory')?.defaultDirectory);
    return preferred?.path ?? workspaces[0]?.path;
  }

  /** The workspace new sessions should join, so they appear in the desktop sidebar. */
  resolveWorkspaceId() {
    const registry = this.ctx.get('workspaceRegistry');
    if (!registry?.list) return undefined;
    let workspaces = [];
    try {
      workspaces = registry.list() ?? [];
    } catch (error) {
      this.logger?.warn?.(`feishu-bridge: cannot read workspaces: ${String(error)}`);
      return undefined;
    }
    if (workspaces.length === 0) return undefined;
    const preferred = this.ctx.get('workingDirectory')?.defaultDirectory;
    const exact = preferred === undefined ? undefined : workspaces.find(entry => entry.path === preferred);
    if (exact) return exact.id;
    // No path matches the default directory: prefer the most recently touched workspace.
    const newest = workspaces
      .slice()
      .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))[0];
    return newest?.id;
  }

  /** Create one session inside the user's workspace, so the desktop sidebar lists it. */
  async createSession() {
    const sessionController = this.ctx.get('sessionController');
    if (!sessionController?.create) throw new Error('当前部署没有 session 控制器');
    const workspaceId = this.resolveWorkspaceId();
    if (workspaceId !== undefined) return sessionController.create({ workspaceId });
    const cwd = this.ctx.get('workingDirectory')?.defaultDirectory;
    return sessionController.create(cwd === undefined ? {} : { cwd });
  }

  /** Short identity shown in card titles; cached for a few minutes. */
  async labelOf(sessionId) {
    const cached = this.sessionLabels.get(sessionId);
    if (cached !== undefined && Date.now() - cached.at < 5 * 60 * 1000) return cached.value;
    let title;
    try {
      const listing = await this.ctx.get('sessionController')?.list?.({}, AbortSignal.timeout(5000));
      const row = (listing?.items ?? []).find(item => item.sessionId === sessionId);
      const candidate = row?.projections?.values?.title;
      title = typeof candidate === 'string' && candidate.trim() !== '' ? candidate.trim() : undefined;
    } catch {
      title = undefined;
    }
    const value = title ?? `session-${String(sessionId).replace(/^session-/, '').slice(0, 8)}`;
    this.sessionLabels.set(sessionId, { value, at: Date.now() });
    return value;
  }

  /** The chat's session, creating and binding one on first use. */
  async ensureSession(chatId, chatType) {
    const existing = this.chats.get(chatId);
    if (existing?.sessionId) return existing.sessionId;
    // Two messages can arrive together in a brand-new chat; share one creation.
    const pending = this.sessionCreations.get(chatId);
    if (pending !== undefined) return await pending;
    const creation = (async () => {
      const created = await this.createSession();
      const sessionId = created.sessionId;
      this.store.bind(chatId, sessionId, chatType);
      this.chats.set(chatId, { sessionId, chatType });
      return sessionId;
    })();
    this.sessionCreations.set(chatId, creation);
    try {
      return await creation;
    } finally {
      this.sessionCreations.delete(chatId);
    }
  }

  /** Per-turn card bookkeeping. */
  newTurnState(chatId, chatType, sessionId, promptText) {
    return {
      chatId,
      chatType,
      sessionId,
      quote: promptText.length > 160 ? `${promptText.slice(0, 160)}…` : promptText,
      label: undefined,
      cardId: undefined,
      messageId: undefined,
      /** Files the agent marked with `present`, sent when the turn settles. */
      outputs: new Set(),
      turn: undefined,
      endReason: undefined,
      startedAt: Date.now(),
      /** step number → finalized assistant text */
      steps: new Map(),
      /** attemptId → { step, text } */
      live: new Map(),
      tools: [],
      dirty: false,
      flushing: false,
      timer: undefined,
      finished: false,
      failed: undefined,
      /** Waiting behind another turn on the same session. */
      queued: false,
      /** Consecutive PATCH failures; two in a row switch to plain text delivery. */
      patchFailures: 0,
      cardBroken: false,
    };
  }

  /** The turn state currently owning a session's stream, if any. */
  headOf(sessionId) {
    return this.active.get(sessionId)?.[0];
  }

  /** Append one turn state to its session queue; true when it becomes the head. */
  enqueue(state) {
    const queue = this.active.get(state.sessionId) ?? [];
    queue.push(state);
    this.active.set(state.sessionId, queue);
    return queue.length === 1;
  }

  /** Remove one settled state and drop the queue when it empties. */
  dequeue(state) {
    const queue = this.active.get(state.sessionId);
    if (queue === undefined) return;
    const index = queue.indexOf(state);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) this.active.delete(state.sessionId);
  }

  /** The next queued turn becomes live once the previous one settles. */
  promoteNext(sessionId) {
    const next = this.headOf(sessionId);
    if (next === undefined || next.finished) return;
    next.queued = false;
    next.startedAt = Date.now();
    next.dirty = true;
    void this.flush(next);
  }

  /** Repaint cards whose turn was still running when this process last stopped. */
  async settleStaleCards() {
    const stale = this.store.takeInflight();
    if (stale.length === 0) return;
    if (this.transport === undefined) {
      this.logger?.warn?.(`feishu-bridge: dropped ${stale.length} stale card record(s) without a connection`);
      return;
    }
    for (const entry of stale) {
      if (typeof entry?.cardId !== 'string') continue;
      // A reload can leave a card recorded while its turn keeps running in the
      // Host. Only a Session that already stopped is genuinely interrupted.
      if (typeof entry.sessionId === 'string') {
        let running;
        try {
          running = (await this.ctx.get('sessionController')?.state?.({ sessionId: entry.sessionId }))?.running;
        } catch {
          running = undefined;
        }
        if (running === true) {
          // Keep tracking it loosely: settle the card when the turn ends.
          if (typeof entry.sessionId === 'string') this.readopted.set(entry.sessionId, entry.cardId);
          continue;
        }
      }
      try {
        await this.transport.patchCard(entry.cardId, cards.interruptedCard({
          quote: entry.quote,
          startedAt: entry.startedAt,
        }));
      } catch (error) {
        this.logger?.warn?.(`feishu-bridge: cannot settle a stale card: ${String(error)}`);
      }
    }
  }

  // ---------------------------------------------------------------- outbound

  /** One committed durable event for a bound session. */
  onSessionEvent(session, event) {
    const sessionId = session?.header?.id ?? session?.id;
    const queue = this.active.get(sessionId);
    // Only turns this plugin opened (a Feishu message) deliver files back:
    // continuing the same Session on the desktop must not push to the phone.
    if (queue === undefined || queue.length === 0) {
      // A card recorded before a reload settles once its turn actually ends.
      if (event.type === 'turn/end' && this.readopted.has(sessionId)) {
        const cardId = this.readopted.get(sessionId);
        this.readopted.delete(sessionId);
        const pending = this.transport?.patchCard?.(cardId, cards.lostTrackingCard());
        if (pending !== undefined) {
          pending.catch((error) => this.logger?.warn?.(`feishu-bridge: cannot settle a readopted card: ${String(error)}`));
        }
      }
      return;
    }
    const state = queue[0];
    if (state.finished) return;
    if (event.type === 'turn/start') {
      if (state.turn === undefined) {
        state.turn = event.data.turn;
        state.startedAt = Date.now();
        state.queued = false;
      }
      state.dirty = true;
      return;
    }
    if (event.type === 'assistant/message') {
      const text = blocksText(event.data.message?.content);
      state.steps.set(event.data.step, text);
      for (const [attemptId, buffer] of state.live) {
        if (buffer.step === event.data.step) state.live.delete(attemptId);
      }
      state.dirty = true;
      return;
    }
    if (event.type === 'tool/call') {
      const name = event.data.name;
      if (typeof name === 'string' && !state.tools.includes(name)) state.tools.push(name);
      if (name === 'present') this.collectPresented(state, event.data.arguments);
      state.dirty = true;
      return;
    }
    if (event.type === 'turn/end') {
      // Settle the state that owns this turn; fall back to the head when the
      // turn started before this process (a resumed or desktop-driven turn).
      const owner = queue.find(item => item.turn === event.data.turn) ?? state;
      if (owner.finished) return;
      owner.endReason = event.data.reason;
      void this.finish(owner);
    }
  }

  /** Token-level stream frames, used for the live part of the card. */
  onAssistantStream(payload) {
    const agent = payload?.agent;
    const frame = payload?.frame;
    const sessionId = agent?.session?.id ?? agent?.id;
    const state = this.headOf(sessionId);
    if (!state || state.finished || !frame) return;
    if (frame.type === 'start') {
      state.live.set(frame.attemptId, { step: frame.step, text: '' });
      state.dirty = true;
      return;
    }
    if (frame.type === 'chunk') {
      const buffer = state.live.get(frame.attemptId);
      const chunk = frame.chunk;
      if (buffer && chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        buffer.text += chunk.text;
        state.dirty = true;
      }
      return;
    }
    if (frame.type === 'end') state.live.delete(frame.attemptId);
  }

  /** Remember the files one `present` call declared. */
  collectPresentedPaths(target, rawArguments) {
    if (typeof rawArguments !== 'string' || rawArguments === '') return;
    let parsed;
    try {
      parsed = JSON.parse(rawArguments);
    } catch {
      return;
    }
    const files = Array.isArray(parsed?.files) ? parsed.files : [];
    for (const entry of files) {
      const path = typeof entry === 'string' ? entry : entry?.path;
      if (typeof path === 'string' && path.trim() !== '') target.add(path.trim());
    }
  }

  /** Remember the files one `present` call declared for a Feishu-opened turn. */
  collectPresented(state, rawArguments) {
    this.collectPresentedPaths(state.outputs, rawArguments);
  }

  /**
   * Upload and send the files one Feishu-opened turn presented, replying under
   * the request that started it.
   */
  async sendOutputs(state) {
    if (this.store.settings.autoSendPresented !== true) return;
    if (state.outputs.size === 0 || this.transport === undefined) return;
    const cwd = await this.sessionCwd(state.sessionId);
    if (cwd === undefined) return;
    const notes = [];
    for (const path of [...state.outputs].slice(0, 8)) {
      try {
        const file = await readWorkspaceFile(cwd, path, this.store.settings.maxOutboundBytes);
        const fileKey = await this.transport.uploadFile(file.name, file.bytes);
        if (state.messageId !== undefined) await this.transport.replyFile(state.messageId, state.chatId, fileKey);
        else await this.transport.sendFile(state.chatId, fileKey);
      } catch (error) {
        notes.push(`${path}：${this.deliveryFailureHint(error)}`);
      }
    }
    if (notes.length > 0) {
      try {
        await this.transport.sendText(state.chatId, `有 ${notes.length} 个交付物没能发送：\n${notes.map(note => `- ${note}`).join('\n')}`);
      } catch (error) {
        this.logger?.warn?.(`feishu-bridge: deliverable note failed: ${String(error)}`);
      }
    }
  }

  /** Current body text: finalized steps plus whichever attempt streams now. */
  currentText(state) {
    const parts = [];
    const steps = [...state.steps.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, text] of steps) if (text) parts.push(text);
    for (const buffer of state.live.values()) if (buffer.text.trim() !== '') parts.push(buffer.text);
    return parts.join('\n\n').trim();
  }

  /** Throttled card refresh. */
  async flush(state) {
    if (state.finished || state.flushing || state.cardBroken || !state.dirty || !state.cardId || !this.transport) return;
    state.flushing = true;
    state.dirty = false;
    try {
      const text = cards.clip(this.currentText(state), this.store.settings.maxCardChars);
      const elapsed = Math.round((Date.now() - state.startedAt) / 1000);
      const tools = state.tools.slice(-8);
      await this.transport.patchCard(state.cardId, cards.progressCard({
        quote: state.quote,
        text,
        tools,
        label: state.label,
        status: state.queued ? '排队中…' : '处理中…',
        stopSession: state.queued ? undefined : state.sessionId,
        note: state.queued
          ? ['等待上一轮结束']
          : [`第 ${state.turn ?? 1} 轮`, `${elapsed}s`, tools.length > 0 ? `${tools.length} 次工具调用` : undefined],
      }));
      state.patchFailures = 0;
    } catch (error) {
      state.patchFailures += 1;
      this.logger?.warn?.(`feishu-bridge: card update failed (${state.patchFailures}): ${String(error)}`);
      if (state.patchFailures >= 2) {
        // Stop trying: a card that cannot be patched twice will not start
        // working, so settle the turn through plain messages instead.
        state.cardBroken = true;
        if (state.timer !== undefined) {
          clearInterval(state.timer);
          state.timer = undefined;
        }
      }
    } finally {
      state.flushing = false;
    }
  }

  /** Why a turn failed, with the code and HTTP status that actually identify it. */
  failureDetail(reason) {
    if (reason?.kind === 'blocked') return '被策略拦截';
    if (reason?.kind !== 'error') return undefined;
    const error = reason.error ?? {};
    const parts = [error.message ?? '未知错误'];
    if (typeof error.code === 'string' && error.code !== '') parts.push(`code: ${error.code}`);
    if (typeof error.status === 'number') parts.push(`status: ${error.status}`);
    return parts.join(' · ');
  }

  /** Write an over-budget answer to the workspace and send it as a markdown file. */
  async deliverLongReply(state, body) {
    try {
      const cwd = await this.sessionCwd(state.sessionId);
      if (cwd === undefined) return false;
      const dir = join(cwd, '.feishu-outbox');
      await mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{6})$/, '$1-$2');
      const name = `回复-${stamp}.md`;
      await writeFile(join(dir, name), body, 'utf8');
      const fileKey = await this.transport.uploadFile(name, Buffer.from(body, 'utf8'));
      if (state.messageId !== undefined) await this.transport.replyFile(state.messageId, state.chatId, fileKey);
      else await this.transport.sendFile(state.chatId, fileKey);
      return true;
    } catch (error) {
      this.logger?.warn?.(`feishu-bridge: long reply file failed: ${String(error)}`);
      return false;
    }
  }

  /**
   * One short text message after a long or failed turn. A card patch never
   * notifies, so this is the only reliable "answer is ready" ping.
   */
  async notifyFinish(state, { elapsed, failed, failureText, body }) {
    const firstLine = (body ?? '').split('\n').map(line => line.trim()).find(line => line !== '') ?? '';
    const text = failed
      ? `⚠️ 失败 · ${elapsed}s\n${(failureText ?? '未知错误').slice(0, 120)}`
      : `✅ 完成 · ${elapsed}s\n${firstLine.slice(0, 80) || '（没有文字输出）'}`;
    try {
      await this.transport.sendText(state.chatId, text);
    } catch (error) {
      this.logger?.warn?.(`feishu-bridge: finish notice failed: ${String(error)}`);
    }
  }

  /** Settle the card once the turn ends (or the prompt fails). */
  async finish(state) {
    if (state.finished) return;
    state.finished = true;
    if (state.timer !== undefined) clearInterval(state.timer);
    this.dequeue(state);
    this.store.removeInflight(state.cardId);
    const settings = this.store.settings;
    const text = this.currentText(state);
    const reason = state.endReason;
    const failed = state.failed !== undefined || reason?.kind === 'error' || reason?.kind === 'blocked';
    const failureText = state.failed ?? this.failureDetail(reason);
    let body = text;
    if (failed) body = `${text === '' ? '' : `${text}\n\n`}**失败**：${failureText ?? '未知错误'}`;
    const long = body.length > settings.maxCardChars;
    const shown = long ? cards.clip(body, settings.cardSummaryChars) : body;
    const elapsed = Math.round((Date.now() - state.startedAt) / 1000);
    let fileDelivered = false;
    if (long && this.transport !== undefined) fileDelivered = await this.deliverLongReply(state, body);
    let cardSettled = false;
    if (state.cardId && this.transport && !state.cardBroken) {
      try {
        await this.transport.patchCard(state.cardId, cards.finalCard({
          quote: state.quote,
          text: shown,
          tools: state.tools.slice(-8),
          failed,
          stopped: reason?.kind === 'aborted',
          truncated: long,
          longForm: fileDelivered ? 'file' : 'text',
          label: state.label,
          footer: [`${elapsed}s`, state.tools.length > 0 ? `${state.tools.length} 次工具调用` : undefined],
        }));
        cardSettled = true;
      } catch (error) {
        this.logger?.warn?.(`feishu-bridge: final card update failed: ${String(error)}`);
      }
    }
    // A card that could not be settled, or a long answer whose file could not
    // be delivered, falls back to plain messages rather than losing the text.
    if ((!cardSettled || (long && !fileDelivered)) && body.length > 0 && this.transport) {
      try {
        for (const piece of chunkText(body, 3500)) await this.transport.sendText(state.chatId, piece);
      } catch (error) {
        this.logger?.warn?.(`feishu-bridge: fallback message failed: ${String(error)}`);
      }
    }
    await this.sendOutputs(state);
    if (this.transport !== undefined && (failed || elapsed * 1000 >= settings.notifyAfterMs)) {
      await this.notifyFinish(state, { elapsed, failed, failureText, body });
    }
    this.promoteNext(state.sessionId);
  }

  // ---------------------------------------------------------------- answers

  /**
   * Give a freshly (re)loaded plugin a moment to reopen its socket before an
   * approval falls back to the desktop UI.
   */
  async waitForTransport(ms = 8000) {
    if (this.transport !== undefined) return true;
    const deadline = Date.now() + ms;
    while (this.transport === undefined && Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 200); });
    }
    return this.transport !== undefined;
  }

  /** Approval waterfall: answer only bindings, otherwise delegate. */
  async handleApproval(request, next) {
    try {
      const sessionId = request?.agent?.session?.id ?? request?.agent?.id;
      const chatId = sessionId === undefined ? undefined : this.store.chatsOf(sessionId)[0];
      if (chatId === undefined) return await next();
      if (!(await this.waitForTransport())) return await next();
      const id = randomUUID();
      const decision = await this.awaitDecision(id, chatId, {
        card: cards.approvalCard({
          requestId: id,
          toolName: request.toolName,
          reason: request.displayReason?.zh ?? request.displayReason?.en ?? request.reason,
        }),
        timeoutMs: this.store.settings.approvalTimeoutMs,
        signal: request.signal,
        onSettled: (verdict, messageId) => {
          if (messageId === undefined) return;
          void this.transport?.patchCard(messageId, cards.approvalSettledCard({
            requestId: id,
            toolName: request.toolName,
            reason: request.reason,
            verdict,
          })).catch(() => {});
        },
      });
      if (decision === 'timeout' || decision === 'unavailable') {
        this.logger?.info?.(`feishu-bridge: approval ${decision}, delegating to the desktop UI`);
        return await next();
      }
      return decision;
    } catch (error) {
      this.logger?.warn?.(`feishu-bridge: approval handling failed, delegating: ${String(error)}`);
      return await next();
    }
  }

  /** Question waterfall: same ownership rule as approvals. */
  async handleQuestion(request, next) {
    try {
      const sessionId = request?.agent?.session?.id ?? request?.agent?.id;
      const chatId = sessionId === undefined
        ? this.store.chatsOf(request?.agent?.id ?? '')[0]
        : this.store.chatsOf(sessionId)[0];
      if (chatId === undefined) return await next();
      if (!(await this.waitForTransport())) return await next();
      const questions = Array.isArray(request.questions) ? request.questions : [];
      if (questions.length === 0) return await next();
      const id = randomUUID();
      const answer = await this.awaitAnswer(id, chatId, questions, request.signal);
      if (answer === null || typeof answer !== 'object') return await next();
      return answer;
    } catch (error) {
      this.logger?.warn?.(`feishu-bridge: question handling failed, delegating: ${String(error)}`);
      return await next();
    }
  }

  /** Post one card and wait for an approval decision, a timeout, or cancellation. */
  awaitDecision(id, chatId, { card, timeoutMs, signal, onSettled }) {
    const pending = {
      kind: 'approval',
      chatId,
      messageId: undefined,
      timer: undefined,
      resolve: undefined,
      next: undefined,
    };
    const settled = new Promise((resolve) => {
      const cleanup = (verdict) => {
        if (pending.timer !== undefined) clearTimeout(pending.timer);
        this.approvals.delete(id);
        signal?.removeEventListener?.('abort', onAbort);
        resolve(verdict);
        try {
          onSettled?.(verdict, pending.messageId);
        } catch (error) {
          this.logger?.warn?.(`feishu-bridge: approval card settle failed: ${String(error)}`);
        }
      };
      pending.resolve = cleanup;
      this.approvals.set(id, pending);
      const onAbort = () => { cleanup('cancelled'); };
      signal?.addEventListener?.('abort', onAbort, { once: true });
      pending.timer = setTimeout(() => { cleanup('timeout'); }, timeoutMs);
      void (async () => {
        try {
          pending.messageId = await this.transport.sendCard(chatId, card);
        } catch (error) {
          this.logger?.warn?.(`feishu-bridge: approval card send failed: ${String(error)}`);
          cleanup('unavailable');
        }
      })();
    });
    return settled;
  }

  /** Post question cards and collect one answer per question. */
  awaitAnswer(id, chatId, questions, signal) {
    const pending = {
      kind: 'question',
      chatId,
      questions,
      answers: new Map(),
      messageIds: [],
      /** index → last painted state, so one settlement does not repaint twice. */
      rendered: new Map(),
      settled: false,
      closedReason: undefined,
      timer: undefined,
      resolve: undefined,
    };
    const settled = new Promise((resolve) => {
      const finish = (value) => {
        if (pending.settled) return;
        pending.settled = true;
        if (pending.timer !== undefined) clearTimeout(pending.timer);
        this.questions.delete(id);
        signal?.removeEventListener?.('abort', onAbort);
        if (value === null || typeof value !== 'object') {
          pending.closedReason = value === 'timeout'
            ? '已超时，转交桌面端处理'
            : value === 'cancelled'
              ? '已取消'
              : '已结束';
        }
        void this.refreshQuestionCards(pending);
        resolve(value);
      };
      const onAbort = () => { finish('cancelled'); };
      pending.finish = finish;
      pending.resolve = (answer) => finish(answer);
      this.questions.set(id, pending);
      signal?.addEventListener?.('abort', onAbort, { once: true });
      pending.timer = setTimeout(() => { finish('timeout'); }, this.store.settings.questionTimeoutMs);
      void (async () => {
        try {
          for (const [index, question] of questions.entries()) {
            const messageId = await this.transport.sendCard(chatId, cards.questionCard({
              requestId: id,
              header: question.header,
              question: question.question,
              detail: question.detail,
              options: Array.isArray(question.options) ? question.options : [],
              index,
              total: questions.length,
            }));
            pending.messageIds[index] = messageId;
            // An answer can arrive while the remaining cards are still posting.
            await this.refreshQuestionCards(pending);
          }
        } catch (error) {
          this.logger?.warn?.(`feishu-bridge: question card send failed: ${String(error)}`);
          finish('unavailable');
        }
      })();
    });
    return settled;
  }

  /** Repaint question cards whose state changed: answered, or closed without an answer. */
  async refreshQuestionCards(pending) {
    if (!this.transport) return;
    for (const [index, question] of pending.questions.entries()) {
      const messageId = pending.messageIds[index];
      if (messageId === undefined) continue;
      const answer = pending.answers.get(index);
      const state = answer !== undefined ? 'answered' : pending.closedReason !== undefined ? 'closed' : 'open';
      if (state === 'open' || pending.rendered.get(index) === state) continue;
      pending.rendered.set(index, state);
      try {
        await this.transport.patchCard(messageId, cards.questionDoneCard({
          header: question.header,
          question: question.question,
          index,
          total: pending.questions.length,
          answer,
          closedReason: pending.closedReason,
        }));
      } catch (error) {
        this.logger?.warn?.(`feishu-bridge: question card update failed: ${String(error)}`);
      }
    }
  }

  /** Typed answer for a pending question: an option label or free text. */
  consumeTypedAnswer(chatId, text) {
    for (const pending of this.questions.values()) {
      if (pending.chatId !== chatId) continue;
      const index = pending.questions.findIndex((_question, position) => !pending.answers.has(position));
      if (index < 0) return false;
      const question = pending.questions[index];
      const option = (question.options ?? []).find(candidate => candidate.label === text);
      pending.answers.set(index, option === undefined
        ? { selected: [], custom: text }
        : { selected: [option.label] });
      void this.refreshQuestionCards(pending);
      this.completeAnswers(pending);
      return true;
    }
    return false;
  }

  /** Resolve a question request once every question has an answer. */
  completeAnswers(pending) {
    if (pending.answers.size < pending.questions.length) return;
    const answers = pending.questions.map((question, index) => {
      const answer = pending.answers.get(index) ?? { selected: [] };
      return {
        id: question.id,
        selected: answer.selected,
        ...(answer.custom === undefined ? {} : { custom: answer.custom }),
      };
    });
    pending.resolve({ answers });
  }

  /** Record one answered question; resolves the whole request when complete. */
  answerQuestion(id, questionIndex, label) {
    const pending = this.questions.get(id);
    if (!pending) return false;
    pending.answers.set(questionIndex, { selected: [label] });
    void this.refreshQuestionCards(pending);
    this.completeAnswers(pending);
    return true;
  }

  /** Typed "允许"/"拒绝" fallback for when card buttons are unavailable. */
  consumeTypedVerdict(chatId, text) {
    const verdict = /^(允许|同意|allow|yes|y)$/i.test(text)
      ? 'allowed-once'
      : /^(拒绝|不同意|deny|no|n)$/i.test(text)
        ? 'rejected'
        : undefined;
    if (verdict === undefined) return false;
    for (const [id, pending] of this.approvals) {
      if (pending.chatId !== chatId) continue;
      pending.resolve?.(verdict);
      this.approvals.delete(id);
      return true;
    }
    return false;
  }

  /** One `card.action.trigger` callback. */
  onCardAction(event) {
    const payload = event?.event ?? event;
    const value = payload?.action?.value ?? {};
    const openId = payload?.operator?.open_id;
    if (!this.store.isOwner(openId)) return { toast: { type: 'error', content: '无权限' } };
    if (value?.t === 'stop') {
      const sessionId = typeof value.s === 'string' ? value.s : undefined;
      const sessionController = this.ctx.get('sessionController');
      if (sessionId === undefined || !sessionController?.cancel) {
        return { toast: { type: 'error', content: '无法停止' } };
      }
      try {
        sessionController.cancel({ sessionId });
        return { toast: { type: 'success', content: '已请求停止' } };
      } catch (error) {
        return { toast: { type: 'error', content: `停止失败：${String(error?.message ?? error)}` } };
      }
    }
    if (value?.t === 'ap') {
      const pending = this.approvals.get(value.id);
      if (!pending) return { toast: { type: 'info', content: '该审批已结束' } };
      pending.resolve?.(value.a === 'allow' ? 'allowed-once' : 'rejected');
      this.approvals.delete(value.id);
      return { toast: { type: 'success', content: value.a === 'allow' ? '已允许' : '已拒绝' } };
    }
    if (value?.t === 'q') {
      const pending = this.questions.get(value.id);
      if (!pending) return { toast: { type: 'info', content: '该提问已结束' } };
      const question = pending.questions[value.qi ?? 0];
      const option = question?.options?.[value.o ?? 0];
      if (!option) return { toast: { type: 'error', content: '选项无效' } };
      this.answerQuestion(value.id, value.qi ?? 0, option.label);
      return { toast: { type: 'success', content: `已选：${option.label}` } };
    }
    return {};
  }

  // ---------------------------------------------------------------- chat commands

  /** Slash commands typed in Feishu. */
  async onChatCommand(message, chatId, chatType, line) {
    const [name, ...rest] = line.slice(1).trim().split(/\s+/);
    const argument = rest.join(' ');
    const sessionId = this.chats.get(chatId)?.sessionId;
    const reply = async (body, title = 'DSH', template = 'blue') => {
      await this.safeReply(message, cards.infoCard({ title, template, body }));
    };
    const sessionController = this.ctx.get('sessionController');
    switch ((name ?? '').toLowerCase()) {
      case 'help': {
        await reply(HELP);
        return;
      }
      case 'whoami': {
        await reply(`open_id: \`${message.sender?.sender_id?.open_id ?? '-'}\`\nchat_id: \`${chatId}\``);
        return;
      }
      case 'new': {
        if (!sessionController?.create) {
          await reply('当前部署没有 session 控制器。', 'DSH · 不可用', 'red');
          return;
        }
        const created = await this.createSession();
        this.store.bind(chatId, created.sessionId, chatType);
        this.chats.set(chatId, { sessionId: created.sessionId, chatType });
        await reply(
          `已新建会话 \`${created.sessionId}\`，后续消息都会发到它。\n\n在桌面侧边栏的工作区里能看到这个会话。`,
          'DSH · 新会话',
          'green',
        );
        return;
      }
      case 'ls': {
        if (!sessionController?.list) {
          await reply('当前部署没有 session 控制器。', 'DSH · 不可用', 'red');
          return;
        }
        const listing = await sessionController.list({}, AbortSignal.timeout(15_000));
        const items = (listing.items ?? []).slice(0, 10);
        this.listings.set(chatId, items);
        const rows = items.map((item, index) => {
          const marker = item.sessionId === sessionId ? ' ←当前' : '';
          return `${index + 1}. ${sessionLabel(item)}${item.running ? ' ▶' : ''}${marker}`;
        });
        await reply(rows.length > 0 ? `${rows.join('\n')}\n\n发 \`/use <序号>\` 切换。` : '还没有会话，发 \`/new\` 建一个。');
        return;
      }
      case 'use': {
        const index = Number.parseInt(argument, 10);
        const items = this.listings.get(chatId) ?? [];
        const target = Number.isInteger(index) ? items[index - 1] : undefined;
        if (!target) {
          await reply('先发 `/ls` 看列表，再发 `/use <序号>`。', 'DSH · 用法', 'orange');
          return;
        }
        this.store.bind(chatId, target.sessionId, chatType);
        this.chats.set(chatId, { sessionId: target.sessionId, chatType });
        await reply(`已切换到 ${sessionLabel(target)}`, 'DSH · 已切换', 'green');
        return;
      }
      case 'stop': {
        if (!sessionController?.cancel || sessionId === undefined) {
          await reply('当前还没有绑定会话。', 'DSH · 提示', 'orange');
          return;
        }
        sessionController.cancel({ sessionId });
        await reply('已请求中断当前回合。', 'DSH · 已中断', 'orange');
        return;
      }
      case 'send': {
        if (!this.transport) {
          await reply('长连接还没就绪，稍后再试。', 'DSH · 不可用', 'red');
          return;
        }
        if (sessionId === undefined) {
          await reply('当前还没有绑定会话，先发一条消息建立会话。', 'DSH · 提示', 'orange');
          return;
        }
        const cwd = await this.sessionCwd(sessionId);
        if (cwd === undefined) {
          await reply('无法确定这个会话的工作目录。', 'DSH · 不可用', 'red');
          return;
        }
        let file;
        try {
          file = await readWorkspaceFile(cwd, argument, this.store.settings.maxOutboundBytes);
        } catch (error) {
          await reply(String(error?.message ?? error), 'DSH · 发送失败', 'orange');
          return;
        }
        try {
          const fileKey = await this.transport.uploadFile(file.name, file.bytes);
          await this.transport.replyFile(message.message_id, chatId, fileKey);
        } catch (error) {
          await reply(this.deliveryFailureHint(error), 'DSH · 发送失败', 'red');
        }
        return;
      }
      case 'status': {
        const models = await this.modelLine(sessionId);
        await reply([
          this.statusText(),
          sessionId ? `- 本群会话：\`${sessionId}\`` : '- 本群会话：未绑定',
          models,
          '',
          HELP,
        ].join('\n'));
        return;
      }
      case 'model': {
        if (!sessionController?.modelCatalog) {
          await reply('当前部署没有模型目录。', 'DSH · 不可用', 'red');
          return;
        }
        const catalog = await sessionController.modelCatalog();
        const list = [];
        for (const group of catalog.groups ?? []) {
          for (const model of group.models ?? []) list.push({ provider: group.id, name: group.name, model });
        }
        if (argument === '') {
          const rows = list.slice(0, 20).map((item, index) => `${index + 1}. ${item.model.name} (${item.name}/${item.model.id})`);
          this.listings.set(`${chatId}:models`, list);
          await reply(`**可用模型**\n${rows.join('\n')}\n\n发 \`/model <序号>\` 切换。`);
          return;
        }
        const index = Number.parseInt(argument, 10);
        const chosen = list[index - 1];
        if (!chosen || sessionId === undefined) {
          await reply('先发 `/model` 看列表，再发 `/model <序号>`。', 'DSH · 用法', 'orange');
          return;
        }
        await sessionController.selectModel({ sessionId, provider: chosen.provider, model: chosen.model.id });
        await reply(`已切换到 ${chosen.model.name}。`, 'DSH · 模型', 'green');
        return;
      }
      default: {
        await reply(`未知命令 \`/${name}\`。\n\n${HELP}`, 'DSH · 帮助', 'orange');
      }
    }
  }

  /** One-line current-model description. */
  async modelLine(sessionId) {
    try {
      const live = sessionId === undefined ? undefined : this.ctx.get('agents')?.get?.(sessionId);
      const selected = live?.model?.current?.();
      if (selected?.provider && selected?.model) return `- 模型：${selected.provider} / ${selected.model}`;
      const catalog = await this.ctx.get('sessionController')?.modelCatalog?.();
      const fallback = catalog?.default;
      return fallback ? `- 默认模型：${fallback.provider} / ${fallback.model}` : '- 模型：未知';
    } catch {
      return '- 模型：未知';
    }
  }

  /** Reply with a card, tolerating a transport failure. */
  async safeReply(message, card) {
    if (!this.transport) return;
    try {
      await this.transport.replyCard(message.message_id, message.chat_id, card);
    } catch (error) {
      this.logger?.warn?.(`feishu-bridge: reply failed: ${String(error)}`);
    }
  }

  // ---------------------------------------------------------------- teardown

  /** Release timers, pending decisions, listeners, and the socket. */
  dispose() {
    if (this.stopped) return;
    this.stopped = true;
    for (const queue of this.active.values()) {
      for (const state of queue) {
        if (state.timer !== undefined) clearInterval(state.timer);
        state.finished = true;
      }
    }
    this.active.clear();
    for (const pending of this.approvals.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.resolve?.('cancelled');
    }
    this.approvals.clear();
    for (const pending of this.questions.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.finish?.('cancelled');
    }
    this.questions.clear();
    this.transport?.stop();
    this.transport = undefined;
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // A listener already gone after HMR is not an error.
      }
    }
  }
}
