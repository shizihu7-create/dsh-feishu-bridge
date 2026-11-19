# dsh-feishu-bridge

用飞书（Lark）机器人操作 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）：**手机发消息、看流式卡片、点审批**。走飞书官方长连接，不需要公网 IP、域名或内网穿透。

> ⚠️ **非官方项目**：与飞书、DeepSeek 均无隶属关系，不代表官方立场。
>
> 📦 **与 npm 上的 `dsh-feishu-bridge` 无关**：npm 上同名包是另一个项目，本项目未发布到 npm。安装请以本仓库为准。

## 特性

| 能力 | 说明 |
|---|---|
| 对话 | 群里 @机器人 / 单聊直接发文字，消息进入该 chat 绑定的 DSH 会话 |
| 流式卡片 | 一张卡片按约 1.2 秒节流刷新，显示工具调用与正文，结束后定稿 |
| 手机审批 | `approval/request` 渲染成卡片按钮：允许一次 / 拒绝；超时转回桌面端 |
| 手机作答 | `ask_user_question` 的选项变成按钮，也可以直接回文字（含自定义答案） |
| 附件入站 | 图片进模型上下文；文件落到会话工作区；支持图文混排（`post`） |
| 命令 | `/new` `/ls` `/use` `/stop` `/status` `/model` `/help` |
| 与桌面互通 | 手机建的会话就是桌面侧边栏里的普通会话，两端看到同一份对话 |

## 工作原理

```
手机飞书 ──@机器人──▶ 飞书云 ──长连接（出站 WebSocket）──▶ 本机 DSH 插件
                                                              │
                     sessionController.prompt()  ──▶ 目标会话（冷会话自动唤醒）
                     session/event、agent/assistant-stream ◀── 流式输出
                     approval/request、user-questions/request ◀── 审批 / 提问
                                                              │
手机飞书 ◀────────────── 卡片消息（节流刷新）──────────────────┘
```

长连接是**出站**连接，所以家用/公司网络都能用。代价是：手机能用 = 这台电脑开着 DSH。

## 前置条件

- **DSH**：桌面版（实测 `0.2.2-rc.5`），Node.js ≥ 22
- **飞书**：企业自建应用（商店应用不适用，见下方说明）
- 这台电脑在使用期间保持开机；睡眠会断线，唤醒后 SDK 自动重连

## 安装

### 1. 克隆并安装依赖

```bash
git clone https://github.com/shizihu7-create/dsh-feishu-bridge.git
cd dsh-feishu-bridge
npm install
```

> 这一步**不能省**。DSH 以 `link:` 方式安装本地 bundle，不会替你安装依赖；缺了 `@larksuiteoapi/node-sdk` 插件启动会报错。

### 2. 在 DSH 里安装

侧边栏 **Plugins** → **Add plugin** → 填入上面这个目录的**绝对路径**（例如 `C:\path\to\dsh-feishu-bridge`）。

安装后会多出一行「飞书机器人」。

### 3. 配置凭据

在 DSH 桌面聊天框执行：

```
/feishu setup <AppID> <AppSecret>
```

凭据存进 DSH 的 credentials 记录（拿不到时退化为插件状态文件 `~/.dsh/feishu-bridge/state.json`），**不写进仓库、不写进配置文件**。

```
/feishu status      # 查看长连接状态
/feishu disconnect  # 断开连接，保留凭据
/feishu reset       # 清空管理员，下次谁先说话谁是管理员
```

看到 `长连接：ready` 就成功了。

## 飞书应用配置

以下全部在[飞书开放平台](https://open.feishu.cn/app)完成，**顺序不能乱**：权限和事件改完必须**重新发布版本**才生效。

### 1. 创建应用与机器人

- 创建**企业自建应用**
- 添加应用能力 → **机器人**

> 为什么必须自建：飞书规定自建应用「只能在同一企业内发布和使用，不可被其他组织使用」。所以本项目交付的是代码 + 自助配置指南，不是可共享的应用。

### 2. 权限（权限管理）

| 权限 | 用途 |
|---|---|
| `im:message`（或 `im:message:readonly`） | 读取消息、下载消息中的图片/文件 |
| `im:message.group_at_msg` | 接收群聊中 @机器人 的消息 |
| `im:message.p2p_msg`（或 `im:message.p2p_msg:readonly`） | 接收单聊消息 |
| `im:message:send_as_bot` | 以应用身份发消息 |
| `im:chat:readonly`（可选） | 读取群信息 |

### 3. 事件订阅（事件与回调 → 事件订阅）

- 订阅方式：**使用长连接接收事件**（不要填请求地址）
- 事件：`im.message.receive_v1`（接收消息）

### 4. 回调配置（同一页面 →「回调配置」）

- 回调：`card.action.trigger`（卡片回传交互）

> 留空也能用：审批和选项卡片会降级为「在群里回『允许』/『拒绝』或直接回文字」。配了才有按钮。

### 5. 发布与可用范围

版本管理与发布 → 创建版本 → 发布。**可用范围要包含你自己**（否则报 `230013`）。

### 6. 把机器人拉进群

群设置 → 群机器人 → 添加你的应用。之后 @机器人 发消息即可。

## 第一次使用

第一个给机器人发消息的人会被自动设为**管理员**（`ownerOpenIds`），之后只响应这个 open_id。

- 单聊：直接发消息
- 群聊：@机器人 后发消息（群里必须 @）

每个 chat 默认对应一个独立会话，首次发消息时自动创建，并落在你的默认工作区，**桌面侧边栏能看到同一个会话**。

## 命令

| 命令 | 作用 |
|---|---|
| `/new` | 给当前 chat 新建会话 |
| `/ls` | 最近 10 个会话 |
| `/use <序号>` | 切到某个会话（接着桌面上的活干） |
| `/stop` | 中断当前回合 |
| `/status` | 连接、绑定、模型 |
| `/model` / `/model <序号>` | 查看 / 切换本会话模型 |
| `/whoami` | 查看自己的 open_id 与 chat_id |
| `/help` | 命令列表 |

## 附件

| 类型 | 处理 |
|---|---|
| 图片（PNG/JPEG/WebP/GIF，≤20 MB） | 作为 prompt 的 image part，模型直接看图 |
| 文件（≤50 MB） | 保存到 `<会话工作目录>/.feishu-uploads/<时间戳>-<原名>`，prompt 给出绝对路径 |
| 图文混排（`post`） | 文字进 prompt，图片进上下文，视频/媒体按文件落盘 |

- 下载走「获取消息中的资源文件」接口（`messageResource.get`），需要上面的读取权限
- 单张下载失败不会丢掉整条消息，文字照常送达，末尾附「（附件提示）」
- 建议把 `.feishu-uploads/` 加进项目 `.gitignore`
- 群聊里单独发图片/文件通常**无法 @机器人**，因此附件主要工作在单聊；群里要传附件，可先发到单聊再 `/use` 同一会话

## 安全与隐私

- **凭据**：只存在你的机器上（credentials 记录或 `~/.dsh/feishu-bridge/state.json`），不进仓库、不进配置
- **白名单**：只有管理员 open_id 能驱动机器人；其他人发消息不响应，单聊会回「无权限」
- **数据流**：飞书消息 → 飞书云 → 你的电脑 → DSH 的模型供应商。自建应用的使用者需自行评估这条链路
- **权限边界**：手机只是「往会话里发消息」，工作区沙箱和审批策略照旧生效，不会因为从手机进来而放宽
- **多人共享电脑**：`/feishu disconnect` 可随时断开

## 限制

- 手机可用 = 电脑开着 DSH；睡眠断线、唤醒自动重连
- **同一个应用只能有一个客户端收到事件**：飞书长连接是集群模式、不广播，部署两处会互相抢消息
- 审批只有一个应答方：飞书绑定的会话，审批只出现在飞书卡片上，桌面 GUI 这次看不到
- 卡片更新受飞书限流（单条 5 QPS），所以是节流刷新而非逐字流式；超长回复自动分段
- 暂不支持：语音、DSH → 手机发送图片/文件、多管理员、按话题分线程

## 故障排查

| 现象 / 错误码 | 原因 | 处理 |
|---|---|---|
| `99991672 Access denied` | 缺少读取类权限 | 开通 `im:message:readonly` 或 `im:message`，再**重新发布版本** |
| `230013` | 你不在应用可用范围 | 版本详情 → 可用范围 → 加入自己 → 发布 |
| `230027` / `234009` | 权限不足 / 外部群限制 | 补权限，或改用内部群 |
| `230020` | 卡片更新触发限流 | 插件已节流，通常自动重试；持续出现可调大 `flushIntervalMs` |
| `234003` | 资源与消息不匹配 | 多为重复事件，通常可忽略 |
| `234004` | 应用不在消息所在会话 | 把机器人拉进该群 |
| 长连接 `ready` 但群里没反应 | 事件订阅不是长连接 / 没订阅 `im.message.receive_v1` / 版本未发布 | 按上面三节逐项核对 |
| 群里发附件无反应 | 图片/文件消息无法 @机器人 | 在单聊发，再 `/use` 切同一会话 |

## 开发

```bash
npm install
npm test          # 离线 dry-run：假服务 + 假传输，覆盖投递/流式/审批/提问/附件/命令
npm run live-check  # 用本机已保存的凭据查询机器人身份与可见会话（只读，需已配置）
```

`test/dry-run.mjs` 不需要任何凭据或网络，可以直接在 CI 里跑。

## 目录结构

```
index.js              # bundle 入口：apply + 生命周期
lib/bridge.js         # 核心：会话投递、流式卡片、审批/提问接管、命令
lib/feishu.js         # 官方 SDK 封装：长连接 + REST
lib/cards.js          # 卡片 JSON 构建
lib/attachments.js    # 图片嗅探、上传落盘
lib/state.js          # 绑定关系、白名单、设置的持久化
cordis.patch.yml      # bundle 插入的插件行
locale/               # 插件页标题与描述
docs/DETAIL.md        # DSH 插件详情页文档
```

## License

[MIT](LICENSE)。飞书官方 Node SDK（`@larksuiteoapi/node-sdk`）为 MIT，版权归 Lark Technologies Pte. Ltd.。
