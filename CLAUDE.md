# WeChat AI Copilot

## 项目目标

在微信聊天时，AI 自动监听消息，给出回复建议（含分析思路），由**人工审核后手动发送**。支持追问调整。计划做成开源项目发布。

---

## 当前进度

- [x] 需求梳理
- [x] `db.js` — SQLite 数据库（建表 + CRUD）
- [x] `wechat.js` — Mock EventEmitter（Windows 上换 WeChatFerry）
- [x] `config.js` — 读取 / 保存 config.yaml
- [x] `ai.js` — Gemini 封装（流式/非流式、AbortController、多轮追问）
- [ ] `server.js` — Express + WebSocket，串联各模块 ← **下一步**
- [ ] 前端主界面（index.html / app.js / style.css）
- [ ] 设置页面（settings.html）
- [ ] Windows 上接入 WeChatFerry 真实消息

---

## 项目结构

```
wechat-ai-copilot/
├── src/
│   ├── config.js        # 读取/写入 config.yaml
│   ├── db.js            # SQLite 操作（contacts/messages/ai_sessions/ai_messages）
│   ├── wechat.js        # Mock EventEmitter / WeChatFerry 预留接口
│   ├── ai.js            # Gemini API 封装
│   └── server.js        # Express + WebSocket（待实现）
├── public/
│   ├── index.html       # 主界面（待实现）
│   ├── settings.html    # 设置页面（待实现）
│   ├── app.js           # 前端逻辑（待实现）
│   └── style.css        # 样式（待实现）
├── test-ai.js           # Gemini API 测试脚本
├── config.yaml          # 用户配置（gitignored，含 API Key）
├── config.yaml.example  # 配置模板
└── package.json         # type: "module"（ESM），主要依赖见下
```

**所有源文件均为 ESM（`import/export`），不能用 `require()`。**

---

## 技术栈

| 模块 | 技术 |
|------|------|
| 微信接入 | WeChatFerry Node.js SDK（Windows）/ Mock EventEmitter（开发） |
| 后端 | Node.js + Express |
| 实时推送 | WebSocket（ws 库），流式 chunk 逐块转发 |
| AI | `@google/genai`（新版 SDK，ESM only） |
| 数据库 | better-sqlite3 |
| 配置 | config.yaml + js-yaml |
| 前端 | 原生 HTML/CSS/JS，无框架 |

---

## 数据库结构（db.js）

**contacts**
| 字段 | 说明 |
|------|------|
| id | 主键 |
| wxid | 微信唯一 ID |
| name | 显示名称 |
| avatar | 头像（可为空） |
| notes | 该联系人的备注信息，拼入 AI prompt |
| last_message | 最后一条消息预览 |
| last_time | 最后消息时间戳（毫秒） |
| has_pending_suggestion | 是否有未处理 AI 建议（列表角标用） |

**messages**
| 字段 | 说明 |
|------|------|
| id | 主键 |
| contact_id | 关联 contacts.id |
| content | 消息文本 |
| is_self | 1=自己发，0=对方发 |
| timestamp | 毫秒时间戳 |
| type | 消息类型，目前只有 'text' |

**ai_sessions**（每个联系人同时只有一个，对方发新消息时 reset）
| 字段 | 说明 |
|------|------|
| id | 主键 |
| contact_id | UNIQUE，关联 contacts.id |
| created_at | 创建时间戳 |

**ai_messages**（AI 面板内容，按 id 顺序即为展示顺序）
| 字段 | 说明 |
|------|------|
| id | 主键，决定展示顺序 |
| session_id | 关联 ai_sessions.id |
| type | `'ai_round'` = AI 生成结果；`'user'` = 用户追问文本 |
| content | type=ai_round 时为 JSON `{message, candidates[]}`；type=user 时为追问文本 |
| created_at | 时间戳 |

---

## AI 模块（ai.js）

**对外暴露的函数：**

```js
// 对方发新消息时调用：重置 session，重新生成建议
generateSuggestions(contactId, chatHistory, { onChunk, onComplete, onError }, notes)

// 用户追问时调用：保留 chat session，继续多轮对话
followUp(contactId, userText, { onChunk, onComplete, onError })

// 取消当前请求（不销毁 chat session）
cancelRequest(contactId)
```

**回调说明：**
- `onChunk(text)` — 流式模式下每收到一块文本触发（非流式不触发）
- `onComplete(result)` — 完成时触发，`result = { message: string, candidates: string[] }`
- `onError(err)` — 出错时触发（主动 abort 不触发）

**内部逻辑：**
- 每个 contactId 对应一个 Gemini `chat` 对象（in-memory，追问时保留上下文）
- 每个 contactId 对应一个 `AbortController`
- `generateSuggestions` 调用时先 abort 旧请求，重建 chat
- `followUp` 调用时只 abort 旧请求，保留 chat（保持追问上下文）
- 流式/非流式由 `config.yaml` 的 `gemini.stream` 控制

**AI 输出格式（responseSchema 强制）：**
```json
{ "message": "AI 的分析和建议（自由发挥）", "candidates": ["回复1", "回复2", "回复3"] }
```

---

## wechat.js

- 导出单例 `WeChatClient extends EventEmitter`
- `start()`：Linux/Mac 下打印 Mock 提示；Windows 下调用 `_startWeChatFerry()`（目前是 stub）
- `receive({ wxid, name, content, isSelf })`：Mock 注入消息，触发 `'message'` 事件
- `'message'` 事件格式：`{ wxid, name, content, isSelf, timestamp, type }`
- WeChatFerry 真实接入代码在 `_startWeChatFerry()` 的注释里，Windows 上取消注释即可

---

## server.js（待实现）

需要实现以下功能：

**HTTP 路由**
- `GET /` → 返回 `public/index.html`
- `GET /settings` → 返回 `public/settings.html`
- `GET /api/contacts` → 返回联系人列表
- `GET /api/contacts/:id/messages` → 返回聊天记录
- `GET /api/contacts/:id/ai-session` → 返回当前 AI session 完整内容
- `POST /api/contacts/:id/followup` → 追问
- `POST /api/contacts/:id/notes` → 更新联系人备注
- `POST /api/mock/message` → Mock 注入消息（触发 wechat.receive()）
- `POST /api/mock/trigger` → 手动触发 AI 生成
- `GET /api/settings` → 读取 config.yaml
- `POST /api/settings` → 保存 config.yaml

**WebSocket 事件（服务端 → 客户端）**
- `{ type: 'message', contactId, message }` — 新消息入库
- `{ type: 'ai_start', contactId }` — AI 开始生成
- `{ type: 'ai_chunk', contactId, chunk }` — 流式 chunk
- `{ type: 'ai_complete', contactId, result }` — 生成完成，result = `{message, candidates}`
- `{ type: 'ai_error', contactId, error }` — 出错
- `{ type: 'contacts_update' }` — 联系人列表有变化，前端重新拉取

**核心逻辑**
- `wechat.on('message')` → 存库 → 如果 `!isSelf` → 调 `ai.generateSuggestions()`
- AI 回调通过 WebSocket 广播给所有已连接的前端客户端
- 启动时调用 `wechat.start()`

---

## 前端界面设计

```
┌──────────┬──────────────────────┬─────────────────────────┐
│  联系人   │     聊天记录          │   AI 助手          [⚙️] │
│  [搜索]  │                      │                         │
│ ● 小A ✦  │   小A: 梅岭，你也     │  AI 的分析和建议...     │
│   小B    │       喜欢爬山？      │  （自由段落，不限格式）  │
│   小C    │   我: （未回复）      │                         │
│          │                      │  [1] 梅岭去过几次    📋  │
│          │                      │  [2] 哈，累成啥样了  📋  │
│          │                      │  [3] 喜欢，第一次去？📋  │
│          │                      │                         │
│          │                      │  ── 追问记录 ──          │
│          │                      │  我: 太正式了轻松点      │
│          │                      │  AI 的新分析...          │
│          │                      │  [4] 哈哈累坏了吧    📋  │
│          │                      │                         │
│          │                      │  [追问输入框    ] [发送] │
├──────────┴──────────────────────┴─────────────────────────┤
│  Mock｜[对方 ▼] [输入消息...       ] [发]  [手动获取建议]  │
└────────────────────────────────────────────────────────────┘
```

- `✦` 角标：`has_pending_suggestion = 1`
- AI 面板随联系人切换，加载该联系人的 `getFullAiSession()` 数据
- 流式模式下 AI 分析段逐字显示，candidates 在 `ai_complete` 事件后渲染
- 📋 复制按钮只复制候选文本，不含分析

**设置页面**（settings.html）：API Key、模型选择、候选数量、Prompt 编辑器、保存

---

## 核心交互流程

```
对方发微信消息
    → wechat.js 触发 'message' 事件
    → server.js 存入 SQLite
    → 若当前有 AI 请求 → AbortController.abort() 取消
    → ai.generateSuggestions() 开始生成
    → 流式 chunk → WebSocket 推送 ai_chunk 事件 → 前端逐字显示
    → 生成完成 → 存入 ai_messages 表 → 推送 ai_complete 事件
    → 用户追问 → ai.followUp() → 同样流式推送
    → 对方再发新消息 → 重置 session，循环
```

---

## 注意事项

- 所有文件是 **ESM**，用 `import/export`，不用 `require()`
- `@google/genai` 是 ESM only，这是当初转 ESM 的原因
- `config.yaml` 不提交 git（含 API Key）
- `better-sqlite3` 在 Windows 安装失败时，换 `sql.js`
- WeChatFerry 只能跑在 **Windows**，需要特定版本微信，不要随意升级
- 使用 WeChatFerry 违反微信服务条款，有封号风险，自行权衡
