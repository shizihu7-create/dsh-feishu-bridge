# 飞书机器人

在飞书群里 @ 机器人，就能驱动这台电脑上的 DSH：发消息、看流式卡片、点审批、答提问。
不需要公网 IP、域名或内网穿透——插件用飞书官方的**长连接**（出站 WebSocket）接收事件。

## 它做了什么

- **收消息**：`im.message.receive_v1` → 去掉 @ 指令后投进绑定会话（`sessionController.prompt`，冷会话会自动唤醒）。
- **发过程**：一轮里用一张卡片按约 1.2 秒节流刷新，显示当前工具调用与正文；卡片定稿后不再更新。
- **审批**：`approval/request` 瀑布事件，只在「飞书绑定的会话」里接管，卡片按钮「允许一次 / 拒绝」；超时（默认 5 分钟）自动交回桌面端。
- **提问**：`user-questions/request` 同理，选项变成按钮。
- **命令**：`/new`、`/ls`、`/use`、`/stop`、`/status`、`/model`、`/help`。
- **附件**：手机发来的图片直接进入模型上下文；文件保存到会话工作目录的 `.feishu-uploads/`，并把绝对路径告诉模型。

## 第一次使用

1. 在飞书开放平台创建企业自建应用，添加**机器人**能力。
2. 权限（缺一个都会报错，按需开）：
   - `im:message`（获取与发送单聊、群组消息）
   - `im:message.group_at_msg`（接收群聊中 @ 机器人消息）
   - `im:message:send_as_bot`（以应用身份发消息）
   - `im:chat:readonly`（读群信息，用于判断是否 @ 了机器人）
3. 事件订阅：`im.message.receive_v1`；回调订阅（「回调配置」页签）：`card.action.trigger`。
4. **订阅方式选「使用长连接接收事件」**，不要填请求地址。
5. 创建版本并发布，把机器人拉进目标群。
6. 在 DSH 聊天框里执行：

   ```
   /feishu setup <App ID> <App Secret>
   ```

   凭据存进 DSH 的 credentials 记录（拿不到时退化为插件自己的状态文件），`/feishu status` 查看连接与权限情况。

7. 群里 @ 机器人 说一句话，第一次会自动把该群绑定到一个新会话。

## 命令

| 命令 | 作用 |
|---|---|
| `/new` | 给当前群新建一个 DSH 会话 |
| `/ls` | 列出最近 10 个会话 |
| `/use <序号>` | 把当前群切到 `/ls` 里的某个会话（接着桌面上的活儿干） |
| `/stop` | 中断当前回合 |
| `/status` | 连接状态、绑定、模型 |
| `/model` / `/model <序号>` | 查看 / 切换本会话模型 |
| 回「允许」/「拒绝」 | 审批按钮不可用时的文字兜底 |

桌面端还有一个管理命令：`/feishu status`、`/feishu setup <AppID> <AppSecret>`、`/feishu disconnect`、`/feishu reset`。

## 状态与排障

- 插件状态文件：`<DSH_HOME>/feishu-bridge/state.json`（默认 `C:\Users\<你>\.dsh\feishu-bridge\state.json`）。里面记录会话绑定、管理员 open_id、设置，以及 `runtime` 快照：`listeners` 是注册的宿主事件数，`commands` 表示 `/feishu` 命令是否注册，`transport` 是长连接状态。
- App Secret 优先存进 DSH 的 credentials 记录（`feishu-bridge/auth`）；该服务不可用时才写进上面这个状态文件。
- 长连接 `ready` 但群里没反应：多半是开放平台的「事件订阅」不是长连接，或没勾 `im.message.receive_v1`，或应用版本没发布、机器人不在可用范围。

## 安装位置

这个包以 `link:` 方式装进 profile，指向工作区里的 `feishu-bridge/` 目录。移动或删除该目录会让插件失效；改代码后需要重新安装或重启 DSH 才会加载新的模块版本。


## 附件

| 类型 | 处理 |
|---|---|
| 图片（PNG/JPEG/WebP/GIF，≤20 MB） | 下载后作为 prompt 的 image part，模型直接看图 |
| 文件（≤50 MB） | 保存到 `<会话工作目录>/.feishu-uploads/<时间戳>-<原名>`，prompt 里给出绝对路径 |
| 图文混排（`post`） | 文字原样进 prompt，其中的图片同样进上下文，视频/媒体按文件落盘 |

- 图片走附件库（`attachments.admitPromptContent`），不落盘，模型能看到，但**不能**用 `read` 工具再读一次。
- 文件落盘，模型用 `read`、`bash` 等工具处理；工作目录外的路径受沙箱限制。
- 超过上限、格式不支持、下载失败都会回一张说明卡，不会静默丢弃。
- `.feishu-uploads/` 建议加进 `.gitignore`。
- 群聊里单独发图片/文件通常**没有 @ 提及**，`im:message.group_at_msg` 不会触发，所以附件主要工作在单聊；群里要发附件，目前只能先把文件发到单聊，再用 `/use` 关联同一个会话。

## 已知限制

- 手机能用 = 这台电脑开着 DSH；休眠或退出后长连接断开，恢复后会重连。
- 审批只有一个应答方：飞书绑定的会话，审批只出现在飞书卡片上，桌面 GUI 这次看不到。
- 卡片更新受飞书限流（单条 5 QPS），所以是节流刷新而不是逐字流式；超长回复自动分段。
- 暂不支持：语音消息、DSH → 手机发送图片或文件。
