# WeChat AI Copilot

## 项目目标

在微信聊天时，AI 自动监听消息，给出回复建议（含分析思路），由**人工审核后手动发送**。支持追问调整。计划做成开源项目发布。

**当前策略**：暂不接入微信客户端（WeChatFerry 不稳定且有封号风险），改为**手动粘贴聊天记录**导入，使用 Mock 栏注入消息。未来可能做"微信分享文本 → PWA Share Target"方案。

---

## 当前进度

- [x] 需求梳理
- [x] `db.js` — SQLite 数据库（建表 + CRUD）
- [x] `wechat.js` — Mock EventEmitter（Windows 上换 WeChatFerry）
- [x] `config.js` — 读取 / 保存 config.yaml
- [x] `ai.js` — Gemini 封装（流式/非流式、AbortController、多轮追问）
- [x] `server.js` — Express + WebSocket，串联各模块
- [x] 前端主界面（index.html / app.js / style.css）
- [x] 设置页面（settings.html）
- [ ] PWA Share Target（微信分享聊天记录直接导入）
- [ ] Windows 上接入 WeChatFerry 真实消息（低优先级）

---

## 项目结构

```
wechat-ai-copilot/
├── src/
│   ├── config.js        # 读取/写入 config.yaml
│   ├── db.js            # SQLite 操作（contacts/messages/ai_sessions/ai_messages）
│   ├── wechat.js        # Mock EventEmitter / WeChatFerry 预留接口
│   ├── ai.js            # Gemini API 封装
│   └── server.js        # Express + WebSocket
├── public/
│   ├── index.html       # 主界面（三栏布局，移动端响应式）
│   ├── settings.html    # 设置页面
│   ├── app.js           # 前端逻辑
│   └── style.css        # 样式
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
| 微信接入 | Mock EventEmitter（手动导入）/ WeChatFerry（Windows，低优先级） |
| 后端 | Node.js + Express，支持 HTTP/HTTPS（读取证书路径自动切换） |
| 实时推送 | WebSocket（ws 库），流式 chunk 逐块转发 |
| AI | `@google/genai`（新版 SDK，ESM only） |
| 数据库 | better-sqlite3（SQLite） |
| 配置 | config.yaml + js-yaml |
| 前端 | 原生 HTML/CSS/JS，无框架，移动端响应式 |

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
| has_pending_suggestion | 是否有未处理 AI 建议（列表红点用），选中联系人时自动清除 |

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

## server.js

**HTTP 路由**
- `GET /` → `public/index.html`
- `GET /settings` → `public/settings.html`
- `GET /api/contacts` → 联系人列表
- `GET /api/contacts/:id/messages` → 聊天记录（`?limit=30`）
- `GET /api/contacts/:id/ai-session` → 当前 AI session 完整内容
- `POST /api/contacts/:id/followup` → 追问（body: `{ text }`）
- `POST /api/contacts/:id/read` → 清除联系人红点（has_pending_suggestion = false）
- `POST /api/contacts/:id/notes` → 更新联系人备注（body: `{ notes }`）
- `POST /api/mock/message` → 注入消息（body: `{ wxid, name, content, isSelf, noAi }`）
- `POST /api/mock/trigger` → 手动触发 AI 生成（body: `{ contactId }`）
- `GET /api/settings` → 读取 config.yaml
- `POST /api/settings` → 保存 config.yaml

**WebSocket 事件（服务端 → 客户端）**
- `{ type: 'message', contactId, message }` — 新消息入库
- `{ type: 'ai_start', contactId }` — AI 开始生成
- `{ type: 'ai_chunk', contactId, chunk }` — 流式 chunk
- `{ type: 'ai_complete', contactId, result }` — 生成完成，result = `{message, candidates}`
- `{ type: 'ai_error', contactId, error }` — 出错
- `{ type: 'contacts_update' }` — 联系人列表有变化，前端重新拉取

**HTTPS 支持**：`config.yaml` 的 `server.certPath` / `server.keyPath` 有值时自动用 `https.createServer`，否则 HTTP。

---

## 前端（app.js）

**布局**：三栏（联系人 / 聊天 / AI），移动端单栏 + 底部导航切换，桌面端 ≥768px 三栏并排。

**状态变量：**
- `contacts` — 联系人列表缓存
- `currentContactId` — 当前选中
- `isStreaming` — AI 是否正在流式输出
- `hasAiSession` — 当前联系人是否有 AI session（控制追问框是否可用）

**Mock 栏功能：**
- 勾选"我发的"：发到当前选中联系人的对话，不触发 AI
- 不勾选：对方发消息，wxid 用 `mock_{name}` 自动路由
- 勾选"不触发AI"：消息只入库/广播，不触发 AI 生成（用于补录历史记录）
- "获取建议"：手动触发当前联系人的 AI 生成

---

## 前端界面

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
│  Mock｜[不触发AI] [我发的] [名字] [消息...] [发] [获取建议]│
└────────────────────────────────────────────────────────────┘
```

- `✦` 红点：`has_pending_suggestion = 1`，选中联系人后自动清除
- 流式模式下 AI 分析段逐字显示，candidates 在 `ai_complete` 后渲染
- 📋 复制按钮只复制候选文本

---

## 配置文件（config.yaml）

```yaml
gemini:
  api_key: "YOUR_GEMINI_API_KEY"
  model: "gemini-2.0-flash"
  candidate_count: 3
  temperature: 0.9
  stream: true

server:
  port: 3000
  # HTTPS（可选，有值时自动启用）
  # certPath: /root/cert/example.com/fullchain.pem
  # keyPath:  /root/cert/example.com/privkey.pem

prompt: |
  你是我的聊天参谋...
```

---

## 核心交互流程

```
对方发消息（Mock 注入 或 WeChatFerry）
    → wechat.js 触发 'message' 事件
    → server.js 存入 SQLite + 广播 message 事件
    → ai.generateSuggestions() 开始生成
    → 流式 chunk → WebSocket 推送 ai_chunk → 前端逐字显示
    → 生成完成 → 存入 ai_messages → 推送 ai_complete
    → 用户追问 → ai.followUp() → 同样流式推送
    → 对方再发新消息 → 重置 session，循环
```

---

## 部署（VPS）

```bash
git clone <repo>
cd wechat-ai-copilot
npm install
cp config.yaml.example config.yaml   # 填入 API Key 和证书路径
npm start
```

推荐用 PM2 保持后台运行：
```bash
npm install -g pm2
pm2 start src/server.js --name wechat-copilot
pm2 save && pm2 startup
```

---

## 注意事项

- 所有文件是 **ESM**，用 `import/export`，不用 `require()`
- `@google/genai` 是 ESM only，这是当初转 ESM 的原因
- `config.yaml` 不提交 git（含 API Key）
- `better-sqlite3` 在 Windows 安装失败时，换 `sql.js`
- 目前**无登录保护**，部署到公网前需要添加认证（TODO）
- WeChatFerry 只能跑在 Windows，需要特定版本微信，有封号风险（低优先级）
