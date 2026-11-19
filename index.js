/**
 * Feishu bot bundle entry.
 *
 * Host-only plugin: it opens one long-lived Feishu WebSocket connection and
 * drives ordinary DSH Sessions through the Host services, so the desktop GUI
 * and the phone see the same conversations.
 */
import { FeishuBridge } from './lib/bridge.js';

export const inject = [];

export function apply(ctx) {
  const bridge = new FeishuBridge(ctx);
  ctx.effect(() => {
    void bridge.start().catch((error) => {
      ctx.logger?.warn?.(`feishu-bridge: start failed: ${String(error)}`);
    });
    return () => { bridge.dispose(); };
  }, 'feishu-bridge: lifecycle');
}
