/**
 * Live diagnostics: asks Feishu for the bot identity and the chats the bot can
 * see, using the credentials the plugin already stored. Read-only.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const lark = require('@larksuiteoapi/node-sdk');

const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME
  : join(homedir(), '.dsh');
const state = JSON.parse(readFileSync(join(home, 'feishu-bridge', 'state.json'), 'utf8'));
if (!state.appId) {
  console.log('no appId configured; run /feishu setup first');
  process.exit(1);
}

const client = new lark.Client({ appId: state.appId, appSecret: state.appSecret, loggerLevel: 3 });

const info = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' });
if (info.code !== 0) {
  console.log(`bot info FAILED: ${info.code} ${info.msg}`);
} else {
  console.log(`bot: ${info.bot.app_name} (${info.bot.open_id})`);
}

try {
  const chats = await client.im.chat.list({ params: { page_size: 20 } });
  if (chats.code !== 0) {
    console.log(`chat list FAILED: ${chats.code} ${chats.msg}`);
  } else {
    const items = chats.data.items ?? [];
    console.log(`chats: ${items.length}`);
    for (const chat of items) console.log(`  - ${chat.name} (${chat.chat_id}) members=${chat.user_count ?? '?'}`);
    if (items.length === 0) console.log('  (机器人还没被拉进任何群，或者缺少 im:chat:readonly 权限)');
  }
} catch (error) {
  console.log(`chat list error: ${error.message}`);
}
