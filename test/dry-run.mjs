/**
 * Offline dry run: exercises the DSH wiring with fake services and a fake
 * Feishu transport. No network, no real bot, no real Session.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FeishuBridge } from '../lib/bridge.js';

const home = mkdtempSync(join(tmpdir(), 'feishu-bridge-home-'));
process.env.DSH_HOME = home;
const workspace = mkdtempSync(join(tmpdir(), 'feishu-workspace-'));

const failures = [];
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` :: ${detail}`}`);
  }
}

const listeners = new Map();
const calls = { prompt: [], created: [], patched: [], sent: [], cancelled: [], selected: [], downloads: [], uploads: [], files: [] };

const services = {
  commands: {
    register(definition) {
      services.command = definition;
      return () => {};
    },
  },
  sessionController: {
    async create(request) {
      calls.created.push(request);
      return { sessionId: 'session-1' };
    },
    async prompt(request) {
      calls.prompt.push(request);
      return { accepted: true };
    },
    async list() {
      return {
        items: [
          { sessionId: 'session-1', running: true, projections: { values: { title: '测试会话' } } },
          { sessionId: 'session-2', running: false, projections: { values: { title: '另一个会话' } } },
        ],
      };
    },
    cancel(request) { calls.cancelled.push(request); },
    async modelCatalog() {
      return {
        default: { provider: 'deepseek-account', model: 'deepseek-flash' },
        groups: [{ id: 'deepseek-account', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }, { id: 'deepseek-pro', name: 'DeepSeek Pro' }] }],
      };
    },
    async selectModel(request) { calls.selected.push(request); return { selected: request }; },
    async state(request) {
      return {
        sessionId: request.sessionId,
        cursor: 0,
        active: true,
        running: request.sessionId === 'session-running',
        queue: [],
        pendingInput: [],
      };
    },
  },
  workingDirectory: { defaultDirectory: 'C:\\Users\\Lenovo\\.dsh\\profiles\\desktop' },
  workspaceRegistry: {
    list: () => [{ id: 'ws-1', path: workspace, title: 'default-workspace', updatedAt: '2026-11-19T15:00:00.000Z', sessionIds: [] }],
  },
  agents: { get: () => undefined },
};

const ctx = {
  logger: { info: () => {}, warn: (line) => console.log(`  [warn] ${line}`) },
  get: (name) => services[name],
  on: (name, listener) => {
    listeners.set(name, listener);
    return () => { listeners.delete(name); };
  },
};

const transport = {
  bot: { open_id: 'ou_bot', app_name: '测试机器人' },
  async replyCard(messageId, chatId, card) { calls.patched.push({ kind: 'reply', card }); return `om_card_${calls.patched.length}`; },
  async sendCard(chatId, card) { calls.patched.push({ kind: 'send', card }); return `om_sent_${calls.patched.length}`; },
  async patchCard(messageId, card) { calls.patched.push({ kind: 'patch', messageId, card }); return undefined; },
  async sendText(chatId, text) { calls.sent.push(text); return 'om_text'; },
  async downloadResource(messageId, fileKey, type) {
    calls.downloads.push({ messageId, fileKey, type });
    if (fileKey === 'bad_key') throw new Error('simulated download failure');
    if (type === 'image') {
      // Minimal PNG signature, enough for the media-type sniff.
      return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
    }
    return Buffer.from('hello from feishu');
  },
  async uploadFile(name, bytes) {
    calls.uploads.push({ name, size: bytes.length, text: bytes.toString() });
    return `file_key_${calls.uploads.length}`;
  },
  async replyFile(messageId, chatId, fileKey) {
    calls.files.push({ messageId, chatId, fileKey });
    return 'om_file_sent';
  },
  async sendFile(chatId, fileKey) {
    calls.files.push({ messageId: undefined, chatId, fileKey });
    return 'om_file_sent';
  },
  describe() { return { state: 'ready', bot: this.bot }; },
  stop() {},
};

/** Find a callback button value in a card. */
function buttonValues(card) {
  const values = [];
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object') {
      if (node.tag === 'button' && node.value) values.push(node.value);
      for (const value of Object.values(node)) walk(value);
    }
  };
  walk(card);
  return values;
}

const tick = (ms = 30) => new Promise((resolve) => { setTimeout(resolve, ms); });
/** Stop the card-refresh loops a prompt opens, so later assertions read the latest deliberate card. */
const clearTurns = () => {
  for (const queue of bridge.active.values()) {
    for (const state of queue) {
      if (state.timer !== undefined) clearInterval(state.timer);
      state.finished = true;
    }
  }
  bridge.active.clear();
};

const bridge = new FeishuBridge(ctx);
await bridge.start();
bridge.transport = transport;
bridge.store.data.settings.flushIntervalMs = 60;
bridge.store.data.settings.approvalTimeoutMs = 5000;
bridge.store.data.settings.questionTimeoutMs = 5000;

console.log('1. pairing + first message');
const first = {
  sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
  message: {
    message_id: 'om_in_1',
    chat_id: 'oc_chat',
    chat_type: 'group',
    message_type: 'text',
    content: JSON.stringify({ text: '@_user_1 你好' }),
    mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: '测试机器人' }],
  },
};
await bridge.onInbound(first);
check('first sender becomes owner', bridge.store.data.ownerOpenIds.includes('ou_owner'));
check('pairing card replied', calls.patched.some(entry => entry.kind === 'reply'));

console.log('2. prompt delivery');
await bridge.onInbound({
  ...first,
  message: { ...first.message, message_id: 'om_in_2', content: JSON.stringify({ text: '@_user_1 帮我看看 README' }) },
});
check('a session was created in the workspace', calls.created.length === 1 && calls.created[0].workspaceId === 'ws-1', JSON.stringify(calls.created[0]));
check('prompt reached session-1', calls.prompt[0]?.sessionId === 'session-1');
check('mention stripped', calls.prompt[0]?.content?.[0]?.text === '帮我看看 README');
check('binding persisted', bridge.store.data.bindings.oc_chat?.sessionId === 'session-1');

console.log('3. non-owner is ignored');
await bridge.onInbound({
  sender: { sender_id: { open_id: 'ou_stranger' }, sender_type: 'user' },
  message: { ...first.message, message_id: 'om_in_3', chat_id: 'oc_other', content: JSON.stringify({ text: '@_user_1 hi' }) },
});
check('stranger did not get a prompt', calls.prompt.length === 1);

console.log('4. streaming card');
const session = { header: { id: 'session-1' } };
listeners.get('session/event')(session, { type: 'turn/start', data: { turn: 1 } });
listeners.get('agent/assistant-stream')({
  agent: { session: { id: 'session-1' } },
  frame: { type: 'start', attemptId: 'a1', revision: 1, startedAfterSeq: 0, turn: 1, step: 1 },
});
listeners.get('agent/assistant-stream')({
  agent: { session: { id: 'session-1' } },
  frame: { type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text: '正在读取' } },
});
await tick(120);
const progress = calls.patched.filter(entry => entry.kind === 'patch').at(-1);
check('progress card carries streamed text', JSON.stringify(progress?.card ?? {}).includes('正在读取'));

console.log('5. final card');
listeners.get('session/event')(session, {
  type: 'tool/call',
  data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' },
});
listeners.get('session/event')(session, {
  type: 'assistant/message',
  data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'README 讲的是插件的用法。' }] } },
});
listeners.get('session/event')(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
await tick(50);
const final = calls.patched.filter(entry => entry.kind === 'patch').at(-1);
check('final card has the answer', JSON.stringify(final?.card ?? {}).includes('README 讲的是插件的用法'));
check('final card has the tool', JSON.stringify(final?.card ?? {}).includes('read'));
check('turn state cleared', bridge.active.size === 0);

console.log('6. approval on a bound session');
let nextCalled = false;
const approvalPromise = listeners.get('approval/request')(
  { agent: { session: { id: 'session-1' } }, toolName: 'bash', reason: '需要写文件' },
  async () => { nextCalled = true; return 'rejected'; },
);
await tick(30);
const approvalButtons = buttonValues(calls.patched.at(-1).card);
check('approval card has two buttons', approvalButtons.length === 2);
const allowButton = approvalButtons.find(entry => entry.a === 'allow');
const toast = bridge.onCardAction({ event: { operator: { open_id: 'ou_owner' }, action: { value: allowButton } } });
check('button answers with a toast', toast?.toast?.type === 'success');
const outcome = await approvalPromise;
check('approval resolved allowed-once', outcome === 'allowed-once', String(outcome));
check('desktop UI was not consulted', nextCalled === false);

console.log('7. approval on another session delegates');
let delegated = false;
const other = await listeners.get('approval/request')(
  { agent: { session: { id: 'session-other' } }, toolName: 'bash' },
  async () => { delegated = true; return 'rejected'; },
);
check('unbound approval delegates to next()', delegated === true && other === 'rejected');

console.log('8. questions');
const questionPromise = listeners.get('user-questions/request')(
  {
    agent: { session: { id: 'session-1' } },
    questions: [
      { id: 'q1', question: '选哪个？', options: [{ label: '甲' }, { label: '乙' }] },
      { id: 'q2', question: '还要吗？', options: [{ label: '要' }] },
    ],
  },
  async () => ({ answers: [] }),
);
await tick(30);
const questionCards = calls.patched.filter(entry => entry.kind === 'send').slice(-2);
check('one card per question', questionCards.length === 2);
for (const card of questionCards) {
  const [value] = buttonValues(card.card);
  bridge.onCardAction({ event: { operator: { open_id: 'ou_owner' }, action: { value } } });
}
const answer = await questionPromise;
check('answers cover both questions', answer?.answers?.length === 2 && answer.answers[0].selected[0] === '甲', JSON.stringify(answer));
check(
  'answered cards repaint without buttons',
  calls.patched.some(entry => entry.kind === 'patch'
    && JSON.stringify(entry.card).includes('已选择')
    && buttonValues(entry.card).length === 0),
);

console.log('8a. typed question answer closes the card');
const typedPromise = listeners.get('user-questions/request')(
  { agent: { session: { id: 'session-1' } }, questions: [{ id: 'q9', question: '用文字回答', options: [{ label: '甲' }, { label: '乙' }] }] },
  async () => ({ answers: [] }),
);
await tick(30);
const openCard = calls.patched.filter(entry => entry.kind === 'send').at(-1)?.card;
check('question card opens with buttons', JSON.stringify(openCard).includes('用文字回答') && buttonValues(openCard).length === 2);
check('typed answer is consumed', bridge.consumeTypedAnswer('oc_chat', '乙') === true);
const typedAnswer = await typedPromise;
check('typed answer reaches the tool', typedAnswer?.answers?.[0]?.selected?.[0] === '乙', JSON.stringify(typedAnswer));
const repainted = calls.patched.filter(entry => entry.kind === 'patch').at(-1)?.card;
check(
  'card repainted as answered with no buttons',
  JSON.stringify(repainted).includes('已选择') && buttonValues(repainted).length === 0,
  JSON.stringify(repainted)?.slice(0, 160),
);

console.log('8b. image message');
await bridge.onInbound({
  sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
  message: {
    ...first.message,
    message_id: 'om_img_1',
    message_type: 'image',
    content: JSON.stringify({ image_key: 'img_key_1' }),
  },
});
await tick(40);
clearTurns();
const imagePrompt = calls.prompt.at(-1);
const imagePart = imagePrompt?.content?.find(part => part.type === 'image');
check('image downloaded through the message-resource API', calls.downloads.some(entry => entry.type === 'image' && entry.fileKey === 'img_key_1'));
check('image enters the prompt as a base64 part', imagePart?.mediaType === 'image/png' && typeof imagePart?.data === 'string' && imagePart.data.length > 0);

console.log('8c. file message');
await bridge.onInbound({
  sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
  message: {
    ...first.message,
    message_id: 'om_file_1',
    message_type: 'file',
    content: JSON.stringify({ file_key: 'file_key_1', file_name: '报告 v2.pdf' }),
  },
});
await tick(40);
clearTurns();
const uploadDir = join(workspace, '.feishu-uploads');
const savedNames = existsSync(uploadDir) ? readdirSync(uploadDir) : [];
const filePrompt = calls.prompt.at(-1);
check('file saved under the session workspace', savedNames.length === 1, savedNames.join(','));
check('saved name keeps the original leaf name', savedNames[0]?.endsWith('报告 v2.pdf') === true, savedNames[0]);
check('prompt cites the saved path', filePrompt?.content?.[0]?.text?.includes('.feishu-uploads') === true, filePrompt?.content?.[0]?.text);
check('saved bytes round-trip', savedNames.length === 1 && readFileSync(join(uploadDir, savedNames[0])).toString() === 'hello from feishu');

console.log('8d. oversize file is refused');
const beforeOversize = calls.prompt.length;
bridge.store.data.settings.maxFileBytes = 4;
await bridge.onInbound({
  sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
  message: { ...first.message, message_id: 'om_file_2', message_type: 'file', content: JSON.stringify({ file_key: 'file_key_2', file_name: 'big.bin' }) },
});
await tick(40);
check('oversize file never reaches the session', calls.prompt.length === beforeOversize);
check('oversize reply explains the limit', JSON.stringify(calls.patched.at(-1)?.card ?? {}).includes('超过上限'));
bridge.store.data.settings.maxFileBytes = 50 * 1024 * 1024;

console.log('8e. unsupported message type');
await bridge.onInbound({
  sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
  message: { ...first.message, message_id: 'om_video_1', message_type: 'media', content: JSON.stringify({ file_key: 'x' }) },
});
await tick(30);
check('media is refused with an explanation', JSON.stringify(calls.patched.at(-1)?.card ?? {}).includes('暂时只接收'));

console.log('8f. rich-text (post) message');
await bridge.onInbound({
  sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
  message: {
    ...first.message,
    message_id: 'om_post_1',
    message_type: 'post',
    content: JSON.stringify({
      title: '标题',
      content: [[{ tag: 'text', text: '配一段文字' }], [{ tag: 'img', image_key: 'img_key_post' }]],
    }),
  },
});
await tick(40);
clearTurns();
const postPrompt = calls.prompt.at(-1);
check('post title and text reach the prompt', postPrompt?.content?.some(part => part.type === 'text' && part.text.includes('配一段文字')) === true);
check('post image reaches the prompt', postPrompt?.content?.some(part => part.type === 'image' && part.mediaType === 'image/png') === true);

console.log('8g. post with an unreadable image still delivers the text');
await bridge.onInbound({
  sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
  message: {
    ...first.message,
    message_id: 'om_post_2',
    message_type: 'post',
    content: JSON.stringify({ content: [[{ tag: 'text', text: '文字保留' }], [{ tag: 'img', image_key: 'bad_key' }]] }),
  },
});
await tick(40);
clearTurns();
const brokenPrompt = calls.prompt.at(-1);
check('text survives a failed image', brokenPrompt?.content?.some(part => part.type === 'text' && part.text.includes('文字保留')) === true);
check('the failure is reported as a note', brokenPrompt?.content?.some(part => part.type === 'text' && part.text.includes('附件提示')) === true);

console.log('9. chat commands');
await bridge.onInbound({
  sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
  message: { ...first.message, message_id: 'om_in_9', content: JSON.stringify({ text: '@_user_1 /ls' }) },
});
check('list command replied', JSON.stringify(calls.patched.at(-1)?.card ?? {}).includes('测试会话'));
const listing = bridge.listings.get('oc_chat');
check('listing cached for /use', Array.isArray(listing) && listing.length === 2);

await bridge.onInbound({
  sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
  message: { ...first.message, message_id: 'om_in_10', content: JSON.stringify({ text: '@_user_1 /use 2' }) },
});
check('/use rebinds the chat', bridge.store.data.bindings.oc_chat?.sessionId === 'session-2');

console.log('10. desktop command');
const statusResult = await services.command.handler({ rawInput: 'status' });
check('/feishu status answers', statusResult?.kind === 'success' && statusResult.text.includes('App ID'));

console.log('12. two messages on one session keep two cards');
clearTurns();
const boundSession = bridge.store.data.bindings.oc_chat.sessionId;
const bound = { header: { id: boundSession } };
const settledBefore = calls.patched.filter(entry => entry.kind === 'patch' && JSON.stringify(entry.card).includes('DSH · 完成')).length;
const promptBefore = calls.prompt.length;
await bridge.onInbound({
  sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
  message: { ...first.message, message_id: 'om_two_1', content: JSON.stringify({ text: '@_user_1 第一条' }) },
});
await bridge.onInbound({
  sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
  message: { ...first.message, message_id: 'om_two_2', content: JSON.stringify({ text: '@_user_1 第二条' }) },
});
await tick(40);
const queued = bridge.active.get(boundSession);
check('both prompts delivered', calls.prompt.length === promptBefore + 2);
check('two turn states queued', Array.isArray(queued) && queued.length === 2, String(queued?.length));
check('the second card is marked queued', queued?.[1]?.queued === true);

listeners.get('session/event')(bound, { type: 'turn/start', data: { turn: 1 } });
listeners.get('session/event')(bound, { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '回复一' }] } } });
listeners.get('session/event')(bound, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
await tick(50);
check('first state settled, one left', bridge.active.get(boundSession)?.length === 1);
check('the queued card was promoted', bridge.active.get(boundSession)?.[0]?.queued === false);

listeners.get('session/event')(bound, { type: 'turn/start', data: { turn: 2 } });
listeners.get('session/event')(bound, { type: 'assistant/message', data: { turn: 2, step: 2, message: { content: [{ type: 'text', text: '回复二' }] } } });
listeners.get('session/event')(bound, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });
await tick(50);
check('no zombie turn state', (bridge.active.get(boundSession) ?? []).length === 0);
const settledAfter = calls.patched.filter(entry => entry.kind === 'patch' && JSON.stringify(entry.card).includes('DSH · 完成')).length;
check('both cards settled', settledAfter - settledBefore === 2, `${settledAfter - settledBefore}`);

console.log('13. leftover cards settle on the next start');
const { Store } = await import('../lib/state.js');
const leftover = new Store(ctx.logger);
leftover.load();
leftover.addInflight({ cardId: 'om_stale_1', chatId: 'oc_chat', quote: '旧消息', startedAt: Date.now() - 60000 });
const quietCtx = {
  logger: ctx.logger,
  get: (name) => (name === 'commands' ? { register: () => () => {} } : undefined),
  on: () => () => {},
};
const restarted = new FeishuBridge(quietCtx);
restarted.transport = transport;
await restarted.start();
await tick(30);
check(
  'stale card repainted as interrupted',
  calls.patched.some(entry => entry.kind === 'patch' && JSON.stringify(entry.card).includes('已中断')),
);
check('stale records cleared', (new Store(ctx.logger)).load().inflight?.length === 0);
restarted.dispose();

console.log('13b. a reload leaves a still-running turn alone');
const reloadStore = new Store(ctx.logger);
reloadStore.load();
reloadStore.addInflight({ cardId: 'om_running_card', chatId: 'oc_chat', sessionId: 'session-running', quote: '跑着的', startedAt: Date.now() });
reloadStore.addInflight({ cardId: 'om_stopped_card', chatId: 'oc_chat', sessionId: 'session-stopped', quote: '停了的', startedAt: Date.now() });
const reloadListeners = new Map();
const reloadCtx = {
  logger: ctx.logger,
  get: (name) => {
    if (name === 'sessionController') return services.sessionController;
    if (name === 'commands') return { register: () => () => {} };
    return undefined;
  },
  on: (name, listener) => {
    reloadListeners.set(name, listener);
    return () => { reloadListeners.delete(name); };
  },
};
const reloadedBridge = new FeishuBridge(reloadCtx);
reloadedBridge.transport = transport;
await reloadedBridge.start();
await tick(40);
check(
  'running turn is not repainted as interrupted',
  !calls.patched.some(entry => entry.kind === 'patch' && entry.messageId === 'om_running_card'),
);
check(
  'stopped turn is repainted',
  calls.patched.some(entry => entry.kind === 'patch' && entry.messageId === 'om_stopped_card' && JSON.stringify(entry.card).includes('已中断')),
);
reloadListeners.get('session/event')({ header: { id: 'session-running' } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
await tick(40);
check(
  'a readopted card settles when its turn ends',
  calls.patched.some(entry => entry.kind === 'patch' && entry.messageId === 'om_running_card' && JSON.stringify(entry.card).includes('已结束')),
);
reloadedBridge.dispose();

console.log('14. a broken card falls back to plain text');
const originalPatch = transport.patchCard;
transport.patchCard = async () => { throw new Error('patch refused'); };
await bridge.onInbound({
  sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
  message: { ...first.message, message_id: 'om_broken_1', content: JSON.stringify({ text: '@_user_1 兜底测试' }) },
});
await tick(40);
listeners.get('session/event')(bound, { type: 'turn/start', data: { turn: 9 } });
listeners.get('session/event')(bound, { type: 'assistant/message', data: { turn: 9, step: 9, message: { content: [{ type: 'text', text: '兜底回答' }] } } });
listeners.get('session/event')(bound, { type: 'turn/end', data: { turn: 9, reason: { kind: 'completed' } } });
await tick(80);
check('answer delivered as text when the card cannot be updated', calls.sent.some(text => text.includes('兜底回答')), JSON.stringify(calls.sent.slice(-2)));
transport.patchCard = originalPatch;

console.log('15. /send delivers a workspace file');
writeFileSync(join(workspace, 'report.txt'), 'outbound payload');
await bridge.onInbound({
  sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
  message: { ...first.message, message_id: 'om_send_1', content: JSON.stringify({ text: '@_user_1 /send report.txt' }) },
});
await tick(40);
check('file uploaded with its bytes', calls.uploads.at(-1)?.name === 'report.txt' && calls.uploads.at(-1)?.text === 'outbound payload');
check('file message sent', typeof calls.files.at(-1)?.fileKey === 'string' && calls.files.at(-1).fileKey.startsWith('file_key_'));

const uploadsBefore = calls.uploads.length;
const outside = join(workspace, '..', `outside-secret-${Date.now()}.txt`);
writeFileSync(outside, 'must not leave the workspace');
await bridge.onInbound({
  sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
  message: { ...first.message, message_id: 'om_send_2', content: JSON.stringify({ text: `@_user_1 /send ../${outside.split(/[\\/]/).pop()}` }) },
});
await tick(40);
check('path traversal refused', calls.uploads.length === uploadsBefore);
check('refusal explains the rule', JSON.stringify(calls.patched.at(-1)?.card ?? {}).includes('只能发送'));
rmSync(outside, { force: true });

console.log('16. files marked with present are sent when the turn settles');
const uploadsBeforePresented = calls.uploads.length;
const filesBeforePresented = calls.files.length;
await bridge.onInbound({
  sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
  message: { ...first.message, message_id: 'om_present_1', content: JSON.stringify({ text: '@_user_1 改一下 report.txt' }) },
});
await tick(40);
listeners.get('session/event')(bound, { type: 'turn/start', data: { turn: 11 } });
listeners.get('session/event')(bound, {
  type: 'tool/call',
  data: {
    turn: 11,
    step: 1,
    callId: 'c-present-1',
    name: 'present',
    arguments: JSON.stringify({ files: [{ path: 'report.txt', description: '改好的文件' }] }),
  },
});
listeners.get('session/event')(bound, {
  type: 'assistant/message',
  data: { turn: 11, step: 1, message: { content: [{ type: 'text', text: '改好了' }] } },
});
listeners.get('session/event')(bound, { type: 'turn/end', data: { turn: 11, reason: { kind: 'completed' } } });
await tick(150);
check(
  'presented file uploaded',
  calls.uploads.length === uploadsBeforePresented + 1 && calls.uploads.at(-1)?.name === 'report.txt',
  JSON.stringify(calls.uploads.at(-1)),
);
check('presented file replied under the request', calls.files.length === filesBeforePresented + 1);

console.log('17. a presented path outside the workspace is refused');
await bridge.onInbound({
  sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
  message: { ...first.message, message_id: 'om_present_2', content: JSON.stringify({ text: '@_user_1 再改一份' }) },
});
await tick(40);
listeners.get('session/event')(bound, { type: 'turn/start', data: { turn: 12 } });
listeners.get('session/event')(bound, {
  type: 'tool/call',
  data: {
    turn: 12,
    step: 1,
    callId: 'c-present-2',
    name: 'present',
    arguments: JSON.stringify({ files: [{ path: '../outside-secret.txt' }] }),
  },
});
listeners.get('session/event')(bound, { type: 'turn/end', data: { turn: 12, reason: { kind: 'completed' } } });
await tick(150);
check('outside path is not uploaded', calls.uploads.length === uploadsBeforePresented + 1);
check('a note explains the failure', calls.sent.some(text => text.includes('没能发送')), JSON.stringify(calls.sent.slice(-1)));

console.log('18. a desktop turn in a bound session sends nothing');
const uploadsBeforeExternal = calls.uploads.length;
const filesBeforeExternal = calls.files.length;
// No deliver(): this turn runs in the host, like a desktop continuation.
listeners.get('session/event')(bound, { type: 'turn/start', data: { turn: 13 } });
listeners.get('session/event')(bound, {
  type: 'tool/call',
  data: { turn: 13, step: 1, callId: 'c-ext-1', name: 'present', arguments: JSON.stringify({ files: [{ path: 'report.txt' }] }) },
});
listeners.get('session/event')(bound, { type: 'turn/end', data: { turn: 13, reason: { kind: 'completed' } } });
await tick(150);
check('desktop turn does not upload', calls.uploads.length === uploadsBeforeExternal);
check('desktop turn does not send a file message', calls.files.length === filesBeforeExternal);

console.log('19. an unbound session sends nothing');
const uploadsBeforeUnbound = calls.uploads.length;
const loose = { header: { id: 'session-unbound' } };
listeners.get('session/event')(loose, {
  type: 'tool/call',
  data: { turn: 1, step: 1, callId: 'c-x', name: 'present', arguments: JSON.stringify({ files: [{ path: 'report.txt' }] }) },
});
listeners.get('session/event')(loose, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
await tick(100);
check('unbound session does not send', calls.uploads.length === uploadsBeforeUnbound);

console.log('20. cards name the session and offer a stop button');
clearTurns();
await bridge.onInbound({
  sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
  message: { ...first.message, message_id: 'om_card_1', content: JSON.stringify({ text: '@_user_1 卡片测试' }) },
});
await tick(60);
const namedCard = calls.patched.at(-1)?.card;
check('card title names the session', JSON.stringify(namedCard).includes('另一个会话'), JSON.stringify(namedCard)?.slice(0, 140));
const stopButton = buttonValues(namedCard).find(value => value.t === 'stop');
check('running card offers a stop button', stopButton !== undefined);
const stopToast = bridge.onCardAction({ event: { operator: { open_id: 'ou_owner' }, action: { value: stopButton } } });
check(
  'stop button cancels the bound session',
  stopToast?.toast?.type === 'success' && calls.cancelled.at(-1)?.sessionId === boundSession,
  JSON.stringify(stopToast),
);
listeners.get('session/event')(bound, { type: 'turn/start', data: { turn: 21 } });
listeners.get('session/event')(bound, { type: 'turn/end', data: { turn: 21, reason: { kind: 'aborted', reason: { kind: 'user' } } } });
await tick(80);
check('an aborted turn settles as stopped', JSON.stringify(calls.patched.at(-1)?.card ?? {}).includes('已停止'));

console.log('21. a long answer becomes a markdown file');
bridge.store.data.settings.maxCardChars = 400;
bridge.store.data.settings.cardSummaryChars = 120;
const uploadsBeforeLong = calls.uploads.length;
const filesBeforeLong = calls.files.length;
await bridge.onInbound({
  sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
  message: { ...first.message, message_id: 'om_long_1', content: JSON.stringify({ text: '@_user_1 写长一点' }) },
});
await tick(40);
listeners.get('session/event')(bound, { type: 'turn/start', data: { turn: 31 } });
listeners.get('session/event')(bound, {
  type: 'assistant/message',
  data: { turn: 31, step: 1, message: { content: [{ type: 'text', text: '长'.repeat(1000) }] } },
});
listeners.get('session/event')(bound, { type: 'turn/end', data: { turn: 31, reason: { kind: 'completed' } } });
await tick(150);
const uploadedLong = calls.uploads.at(-1);
check(
  'long answer uploaded as markdown',
  calls.uploads.length === uploadsBeforeLong + 1 && /^回复-.*\.md$/.test(uploadedLong?.name ?? ''),
  JSON.stringify(uploadedLong?.name),
);
check('long answer replied as a file', calls.files.length === filesBeforeLong + 1);
const longCard = calls.patched.at(-1)?.card;
check(
  'card keeps a summary and points at the file',
  JSON.stringify(longCard).includes('作为文件发送'),
  JSON.stringify(longCard)?.slice(0, 160),
);
bridge.store.data.settings.maxCardChars = 9000;
bridge.store.data.settings.cardSummaryChars = 1500;

console.log('22. a failed turn shows the provider code');
await bridge.onInbound({
  sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
  message: { ...first.message, message_id: 'om_fail_1', content: JSON.stringify({ text: '@_user_1 失败的回合' }) },
});
await tick(40);
listeners.get('session/event')(bound, { type: 'turn/start', data: { turn: 32 } });
listeners.get('session/event')(bound, {
  type: 'turn/end',
  data: { turn: 32, reason: { kind: 'error', error: { message: 'rate limited', code: 'RATE_LIMIT', status: 429 } } },
});
await tick(120);
const failedCard = calls.patched.at(-1)?.card;
check(
  'failure names the code and status',
  JSON.stringify(failedCard).includes('RATE_LIMIT') && JSON.stringify(failedCard).includes('429'),
  JSON.stringify(failedCard)?.slice(0, 200),
);

console.log('23. long turns ping the phone, quick ones stay quiet');
clearTurns();
await bridge.onInbound({
  sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
  message: { ...first.message, message_id: 'om_notify_1', content: JSON.stringify({ text: '@_user_1 快问快答' }) },
});
await tick(40);
listeners.get('session/event')(bound, { type: 'turn/start', data: { turn: 41 } });
listeners.get('session/event')(bound, {
  type: 'assistant/message',
  data: { turn: 41, step: 1, message: { content: [{ type: 'text', text: '很快的回答' }] } },
});
listeners.get('session/event')(bound, { type: 'turn/end', data: { turn: 41, reason: { kind: 'completed' } } });
await tick(140);
check('quick turn sends no notice', !calls.sent.some(text => text.includes('✅ 完成')));

await bridge.onInbound({
  sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
  message: { ...first.message, message_id: 'om_notify_2', content: JSON.stringify({ text: '@_user_1 慢任务' }) },
});
await tick(40);
listeners.get('session/event')(bound, { type: 'turn/start', data: { turn: 42 } });
const slow = bridge.active.get(boundSession);
if (slow?.[0]) slow[0].startedAt = Date.now() - 60000;
listeners.get('session/event')(bound, {
  type: 'assistant/message',
  data: { turn: 42, step: 1, message: { content: [{ type: 'text', text: '慢回答' }] } },
});
listeners.get('session/event')(bound, { type: 'turn/end', data: { turn: 42, reason: { kind: 'completed' } } });
await tick(160);
check(
  'slow turn sends a finish notice',
  calls.sent.some(text => text.includes('✅ 完成') && text.includes('慢回答')),
  JSON.stringify(calls.sent.at(-1)),
);

await bridge.onInbound({
  sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
  message: { ...first.message, message_id: 'om_notify_3', content: JSON.stringify({ text: '@_user_1 失败快答' }) },
});
await tick(40);
listeners.get('session/event')(bound, { type: 'turn/start', data: { turn: 43 } });
listeners.get('session/event')(bound, {
  type: 'turn/end',
  data: { turn: 43, reason: { kind: 'error', error: { message: 'gateway down', code: 'GATEWAY', status: 502 } } },
});
await tick(160);
check(
  'a failure notifies even when quick',
  calls.sent.some(text => text.includes('⚠️ 失败') && text.includes('GATEWAY')),
  JSON.stringify(calls.sent.at(-1)),
);

console.log('11. teardown');
bridge.dispose();
check('listeners disposed', listeners.size === 0);

console.log(`\n${failures.length === 0 ? 'PASS' : `FAIL (${failures.length}): ${failures.join(', ')}`}`);
process.exitCode = failures.length === 0 ? 0 : 1;
