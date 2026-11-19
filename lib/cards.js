/**
 * Feishu interactive-card builders.
 * Card schema v1 is used on purpose: `config.update_multi` is the documented
 * requirement for PATCH-based updates, and every element below is stable v1.
 */

/** Trim text to a character budget without splitting a surrogate pair. */
export function clip(text, limit) {
  if (typeof text !== 'string') return '';
  if (text.length <= limit) return text;
  const cut = text.slice(0, Math.max(0, limit - 24));
  return `${cut}\n\n…（内容过长，已截断）`;
}

function markdown(content) {
  return { tag: 'markdown', content };
}

function divider() {
  return { tag: 'hr' };
}

function note(lines) {
  return {
    tag: 'note',
    elements: [{ tag: 'plain_text', content: lines.filter(Boolean).join(' · ') }],
  };
}

function button(label, type, value) {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    value,
  };
}

/** A card that can be patched later: `update_multi` must be present before and after every update. */
function shell({ title, template, elements }) {
  return {
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      template,
      title: { tag: 'plain_text', content: title },
    },
    elements,
  };
}

/** Compose the shared body: quoted prompt, assistant text, tool trace. */
function bodyElements({ quote, text, tools, placeholder }) {
  const elements = [];
  if (quote) elements.push(markdown(`**你：**\n> ${quote.split('\n').join('\n> ')}`));
  if (quote && (text || tools?.length)) elements.push(divider());
  elements.push(markdown(text && text.trim() !== '' ? text : placeholder));
  if (tools && tools.length > 0) {
    elements.push(divider());
    elements.push(markdown(`**工具**\n${tools.map(name => `- \`${name}\``).join('\n')}`));
  }
  return elements;
}

/** The card shown while a turn runs; refreshed on a throttle. */
export function progressCard({ quote, text, tools, note: footer, status = '处理中…' }) {
  return shell({
    title: `DSH · ${status}`,
    template: 'blue',
    elements: [
      ...bodyElements({ quote, text, tools, placeholder: '_等待模型输出…_' }),
      divider(),
      note([footer]),
    ],
  });
}

/** The card a finished turn settles into. */
export function finalCard({ quote, text, tools, footer, failed = false, truncated = false }) {
  return shell({
    title: failed ? 'DSH · 出错' : 'DSH · 完成',
    template: failed ? 'red' : 'green',
    elements: [
      ...bodyElements({ quote, text, tools, placeholder: failed ? '_本轮失败_' : '_（没有文字输出）_' }),
      ...(truncated ? [markdown('_回复较长，完整内容已分段发送。_')] : []),
      divider(),
      note([footer]),
    ],
  });
}

/** Missing approval card: one-shot decision only. */
export function approvalCard({ requestId, toolName, reason, agentLabel }) {
  return shell({
    title: 'DSH · 需要授权',
    template: 'orange',
    elements: [
      markdown(`**工具**\n\`${toolName}\`${agentLabel ? `\n**会话** ${agentLabel}` : ''}${reason ? `\n\n**原因**\n${reason}` : ''}`),
      divider(),
      {
        tag: 'action',
        actions: [
          button('允许一次', 'primary', { t: 'ap', id: requestId, a: 'allow' }),
          button('拒绝', 'danger', { t: 'ap', id: requestId, a: 'deny' }),
        ],
      },
      note(['点按钮，或在群里回「允许」/「拒绝」。超时后自动转回桌面端。']),
    ],
  });
}

/** The card a decided approval settles into, so the buttons stop looking live. */
export function approvalSettledCard({ requestId, toolName, reason, verdict }) {
  const title = verdict === 'allowed-once'
    ? 'DSH · 已允许'
    : verdict === 'rejected'
      ? 'DSH · 已拒绝'
      : verdict === 'timeout'
        ? 'DSH · 已转交桌面端'
        : verdict === 'cancelled'
          ? 'DSH · 已取消'
          : 'DSH · 未处理';
  const result = verdict === 'allowed-once'
    ? '允许一次'
    : verdict === 'rejected'
      ? '拒绝'
      : verdict === 'timeout'
        ? '手机端超时，已转交桌面端处理'
        : verdict === 'cancelled'
          ? '请求已取消'
          : '未能送达';
  return shell({
    title,
    template: verdict === 'allowed-once' ? 'green' : 'grey',
    elements: [
      markdown(`**工具**\n\`${toolName}\`${reason ? `\n\n**原因**\n${reason}` : ''}`),
      divider(),
      note([`审批结果：${result}`]),
    ],
  });
}

/** One question with its options rendered as buttons. */
export function questionCard({ requestId, header, question, detail, options, index, total }) {
  const actions = options.map((option, position) => button(
    option.label.slice(0, 30),
    position === 0 ? 'primary' : 'default',
    { t: 'q', id: requestId, qi: index, o: position },
  ));
  return shell({
    title: `DSH · 需要选择${total > 1 ? ` (${index + 1}/${total})` : ''}`,
    template: 'turquoise',
    elements: [
      ...(header ? [markdown(`**${header}**`)] : []),
      markdown(`**${question}**${detail ? `\n\n${detail}` : ''}`),
      ...(options.length > 0 ? [divider(), { tag: 'action', actions: actions.slice(0, 4) }] : []),
      ...(options.length > 4 ? [{ tag: 'action', actions: actions.slice(4, 8) }] : []),
      note(['点按钮，或直接回文字作答。']),
    ],
  });
}

/** A closed question card: the chosen answer, or why it closed. Buttons are dropped. */
export function questionDoneCard({ header, question, index, total, answer, closedReason }) {
  const chosen = answer === undefined
    ? undefined
    : (answer.selected?.[0] ?? answer.custom ?? '（空）');
  return shell({
    title: chosen === undefined ? 'DSH · 已结束' : 'DSH · 已选择',
    template: chosen === undefined ? 'grey' : 'green',
    elements: [
      ...(header ? [markdown(`**${header}**`)] : []),
      markdown(`**${question}**${total > 1 ? ` (${index + 1}/${total})` : ''}`),
      divider(),
      note([chosen === undefined ? (closedReason ?? '已结束') : `已选：${chosen}`]),
    ],
  });
}

/** A free-text informational card. */
export function infoCard({ title = 'DSH', template = 'blue', body }) {
  return shell({ title, template, elements: [markdown(body)] });
}
