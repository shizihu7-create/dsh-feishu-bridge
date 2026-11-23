/**
 * Durable plugin state: bindings, allow list, settings and de-duplication.
 * Kept in the user's DSH home instead of the workspace so it survives workspace cleanup.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STATE_VERSION = 1;

/** Tunables a user may override in the state file. */
export const DEFAULT_SETTINGS = {
  /** Card refresh cadence while a turn runs, in milliseconds (Feishu allows 5 QPS per card). */
  flushIntervalMs: 1200,
  /** How long an approval waits on the phone before it is handed back to the desktop GUI. */
  approvalTimeoutMs: 5 * 60 * 1000,
  /** How long a question waits on the phone before the desktop GUI answers it. */
  questionTimeoutMs: 4 * 60 * 1000,
  /** Card body budget in characters; longer assistant text is sent as follow-up messages. */
  maxCardChars: 9000,
  /** How much of an over-budget answer stays in the card; the rest becomes a file. */
  cardSummaryChars: 1500,
  /** Ring size for de-duplicated Feishu message ids. */
  seenLimit: 400,
  /** Largest image accepted from the phone, in bytes (the image enters the prompt as base64). */
  maxImageBytes: 20 * 1024 * 1024,
  /** Largest file accepted from the phone, in bytes (saved under the session's workspace). */
  maxFileBytes: 50 * 1024 * 1024,
  /** Largest file the phone may pull back, in bytes (Feishu caps an upload at 30 MB). */
  maxOutboundBytes: 30 * 1024 * 1024,
  /** Push files the agent marked with `present` without waiting for `/send`. */
  autoSendPresented: true,
  /** A finished turn longer than this sends one short text message, so the phone notifies. */
  notifyAfterMs: 20000,
};

/** Resolve the plugin state directory, honouring DSH_HOME like the rest of the product. */
export function stateDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
  return join(home, 'feishu-bridge');
}

/** Empty state for a first run. */
function initialState() {
  return {
    version: STATE_VERSION,
    appId: '',
    ownerOpenIds: [],
    blockedOpenIds: [],
    /** chatId -> { sessionId, chatType, updatedAt } */
    bindings: {},
    seenMessageIds: [],
    /**
     * Cards whose turn was still running when this process started. They are
     * repainted as interrupted on the next start, so a restart never leaves a
     * stale "processing" card behind.
     */
    inflight: [],
    settings: { ...DEFAULT_SETTINGS },
    /** Last successful connection, for /feishu status. */
    lastConnectedAt: undefined,
  };
}

/** JSON state with atomic writes. */
export class Store {
  constructor(logger) {
    this.logger = logger;
    this.dir = stateDir();
    this.path = join(this.dir, 'state.json');
    this.data = initialState();
  }

  /** Load the state file, tolerating a missing or corrupt one. */
  load() {
    try {
      if (existsSync(this.path)) {
        const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
        if (parsed && typeof parsed === 'object') {
          this.data = {
            ...initialState(),
            ...parsed,
            settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
            bindings: parsed.bindings && typeof parsed.bindings === 'object' ? parsed.bindings : {},
            ownerOpenIds: Array.isArray(parsed.ownerOpenIds) ? parsed.ownerOpenIds : [],
            blockedOpenIds: Array.isArray(parsed.blockedOpenIds) ? parsed.blockedOpenIds : [],
            seenMessageIds: Array.isArray(parsed.seenMessageIds) ? parsed.seenMessageIds : [],
            inflight: Array.isArray(parsed.inflight) ? parsed.inflight : [],
          };
        }
      }
    } catch (error) {
      this.logger?.warn?.(`feishu-bridge: state file unreadable, starting empty: ${String(error)}`);
      this.data = initialState();
    }
    return this.data;
  }

  /** Persist the current state atomically with owner-only permissions where supported. */
  save() {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(this.data, undefined, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, this.path);
      try {
        chmodSync(this.path, 0o600);
      } catch {
        // Windows has no POSIX modes; the profile directory is already user-scoped.
      }
    } catch (error) {
      this.logger?.warn?.(`feishu-bridge: cannot save state: ${String(error)}`);
    }
  }

  get settings() {
    return { ...DEFAULT_SETTINGS, ...(this.data.settings ?? {}) };
  }

  /** Record one card whose turn is still running. */
  addInflight(entry) {
    this.data.inflight = [...(this.data.inflight ?? []).filter(item => item.cardId !== entry.cardId), entry];
    this.save();
  }

  /** Forget one card once its turn settled. */
  removeInflight(cardId) {
    if (cardId === undefined) return;
    const next = (this.data.inflight ?? []).filter(item => item.cardId !== cardId);
    if (next.length === (this.data.inflight ?? []).length) return;
    this.data.inflight = next;
    this.save();
  }

  /** Take every leftover card and clear the list, so each is settled once. */
  takeInflight() {
    const pending = this.data.inflight ?? [];
    if (pending.length === 0) return [];
    this.data.inflight = [];
    this.save();
    return pending;
  }

  /** Remember a Feishu message id; true when it was not seen before. */
  markSeen(messageId) {
    if (typeof messageId !== 'string' || messageId === '') return true;
    const seen = this.data.seenMessageIds;
    if (seen.includes(messageId)) return false;
    seen.push(messageId);
    const limit = this.settings.seenLimit;
    if (seen.length > limit) seen.splice(0, seen.length - limit);
    this.save();
    return true;
  }

  /** The binding for one chat, if any. */
  bindingOf(chatId) {
    return this.data.bindings[chatId];
  }

  /** Bind a chat to a session. */
  bind(chatId, sessionId, chatType) {
    this.data.bindings[chatId] = { sessionId, chatType, updatedAt: Date.now() };
    this.save();
    return this.data.bindings[chatId];
  }

  /** Drop a chat binding. */
  unbind(chatId) {
    delete this.data.bindings[chatId];
    this.save();
  }

  /** Every chat bound to one session (a session may be reachable from more than one chat). */
  chatsOf(sessionId) {
    return Object.entries(this.data.bindings)
      .filter(([, value]) => value?.sessionId === sessionId)
      .map(([chatId]) => chatId);
  }

  /** Whether an open id may drive the bot. */
  isOwner(openId) {
    return typeof openId === 'string' && this.data.ownerOpenIds.includes(openId);
  }

  /** First-run pairing: the first sender becomes the owner. */
  claimOwner(openId) {
    if (typeof openId !== 'string' || openId === '') return false;
    if (this.data.blockedOpenIds.includes(openId)) return false;
    this.data.ownerOpenIds = [openId];
    this.save();
    return true;
  }

  /** Clear the owner list; the next sender claims it. */
  resetOwners() {
    this.data.ownerOpenIds = [];
    this.save();
  }
}
