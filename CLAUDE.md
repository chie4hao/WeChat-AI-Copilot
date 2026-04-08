# WeChat AI Copilot

## 项目目标

在微信聊天时，AI 自动分析聊天记录，给出回复建议（含分析思路），由**人工审核后手动发送**。支持追问调整。计划做成开源项目发布。

**核心理念**：AI 只是助手，人永远是最终决策者。所有 AI 建议都需要人工审核才会发出。

**当前接入方式**：暂不接入微信客户端（WeChatFerry 不稳定且有封号风险）。目前通过两种方式导入聊天记录：
1. **PWA Share Target**（主要方式）：手机微信多选消息 → 分享 → 选"AI Copilot" → 自动解析导入
2. **Mock 栏手动注入**：界面底部的调试栏，逐条或批量输入消息

---

## 当前进度

- [x] 需求梳理
- [x] `db.js` — SQLite 数据库（建表 + CRUD）
- [x] `wechat.js` — Mock EventEmitter（Windows 上换 WeChatFerry）
- [x] `config.js` — 读取 / 保存 config.yaml
- [x] `ai.js` — Gemini 封装（流式/非流式、AbortController、多轮追问、重启后恢复 session）
- [x] `server.js` — Express + WebSocket，串联各模块，HTTPS 支持，IP 白名单
- [x] 前端主界面（index.html / app.js / style.css）— 三栏布局，移动端响应式
- [x] 设置页面（settings.html）— 含所有配置项（API Key、模型、证书路径、IP 白名单等）
- [x] PWA（manifest.json / sw.js / icon）— 可安装到手机桌面，支持 Share Target 接收微信分享
- [x] 导入页面（import.html）— 解析微信聊天记录格式，批量导入，自动识别"我"
- [ ] 联系人管理（手动添加/删除）— 目前只能通过导入自动创建
- [ ] WeChatFerry 真实消息接入（Windows，低优先级）

---

## 项目结构

```
wechat-ai-copilot/
├── src/
│   ├── config.js        # 读取/写入 config.yaml（__dirname 定位，与启动目录无关）
│   ├── db.js            # SQLite 操作，数据库文件在项目根 data.db
│   ├── wechat.js        # Mock EventEmitter / WeChatFerry 预留接口
│   ├── ai.js            # Gemini API 封装，含流式解析和 session 恢复
│   └── server.js        # Express + WebSocket，所有路由和核心逻辑
├── public/
│   ├── index.html       # 主界面（三栏布局，移动端响应式）
│   ├── app.js           # 前端逻辑
│   ├── style.css        # 全局样式（CSS 变量，移动优先）
│   ├── settings.html    # 设置页面（含所有 config.yaml 字段）
│   ├── import.html      # 聊天记录导入页（解析微信格式 + 批量写库）
│   ├── manifest.json    # PWA manifest（含 share_target 声明）
│   ├── sw.js            # Service Worker（拦截 Share Target POST，存 IndexedDB）
│   ├── icon-192.png     # PWA 图标
│   └── icon-512.png     # PWA 图标
├── config.yaml          # 用户配置（gitignored，含 API Key）
├── config.yaml.example  # 配置模板
├── package.json         # type: "module"（ESM），Node ≥ 18
└── data.db              # SQLite 数据库文件（gitignored，运行时自动创建）
```

**所有源文件均为 ESM（`import/export`），绝对不能用 `require()`。**

---

## 技术栈

| 模块 | 技术 | 说明 |
|------|------|------|
| 微信接入 | PWA Share Target + Mock | 手机分享或手动注入，暂不接微信客户端 |
| 后端 | Node.js + Express | HTTP/HTTPS 自动切换 |
| 实时推送 | WebSocket（ws 库） | 流式 chunk 逐块转发到前端 |
| AI | `@google/genai`（ESM only） | Gemini API，强制 JSON schema 输出 |
| 数据库 | better-sqlite3（SQLite） | 同步 API，WAL 模式 |
| 配置 | config.yaml + js-yaml | 保存时合并，不会覆盖未知字段 |
| 前端 | 原生 HTML/CSS/JS | 无框架，移动端响应式 |
| PWA | manifest + Service Worker | Share Target 接收微信分享 |

---

## 配置文件（config.yaml）

完整字段说明：

```yaml
# 你的微信昵称，导入聊天记录时自动识别哪条消息是你发的
my_name: "你的微信昵称"

gemini:
  api_key: "YOUR_GEMINI_API_KEY"
  model: "gemini-2.0-flash"       # 模型名，可在设置页切换
  candidate_count: 3               # AI 给出的候选回复数量
  temperature: 0.9
  stream: true                     # true=流式逐字显示，false=等完整结果

server:
  port: 3000
  certPath: /root/cert/example.com/fullchain.pem  # 有值则自动启用 HTTPS
  keyPath:  /root/cert/example.com/privkey.pem
  allowedIPs:                      # IP 白名单，空则不限制
    - "1.2.3.4"                    # 填 VPS 公网 IP（通过代理访问时来源是 VPS 自身 IP）

prompt: |
  你是我的聊天参谋...              # 系统 prompt，聊天记录由程序自动拼入
```

**重要**：`config.yaml` 在 git 中被忽略，不会提交。`POST /api/settings` 保存时会合并 `server` 字段（而不是完全覆盖），防止 certPath 等敏感字段丢失。

---

## 数据库结构（db.js）

数据库文件：项目根目录 `data.db`，启动时自动创建。

**contacts**
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | 自增主键 |
| wxid | TEXT UNIQUE | 微信唯一 ID（Mock 导入时为 `mock_{name}`） |
| name | TEXT | 显示名称 |
| avatar | TEXT | 头像（目前未使用，预留） |
| notes | TEXT | 联系人备注，拼入 AI prompt 的 `【关于这个人】` 段 |
| last_message | TEXT | 最后一条消息预览（列表显示用） |
| last_time | INTEGER | 最后消息时间戳（毫秒），列表排序依据 |
| has_pending_suggestion | INTEGER | 0/1，AI 建议未读标记（红点）；选中联系人时自动清除 |

**messages**
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | 自增主键 |
| contact_id | INTEGER FK | 关联 contacts.id |
| content | TEXT | 消息文本 |
| is_self | INTEGER | 1=自己发，0=对方发 |
| timestamp | INTEGER | 毫秒时间戳 |
| type | TEXT | 消息类型，目前只有 `'text'` |

**ai_sessions**（每个联系人唯一，对方发新消息时 reset，旧记录删除重建）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | 自增主键 |
| contact_id | INTEGER UNIQUE FK | 关联 contacts.id，每人只有一个 session |
| created_at | INTEGER | 创建时间戳 |

**ai_messages**（AI 面板展示内容，按 id 顺序即展示顺序）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | 自增主键，决定展示顺序 |
| session_id | INTEGER FK | 关联 ai_sessions.id |
| type | TEXT | `'ai_round'` = AI 生成结果；`'user'` = 用户追问文本 |
| content | TEXT | `ai_round` 时为 JSON `{"analysis": "...", "candidates": [...]}`；`user` 时为追问文本 |
| created_at | INTEGER | 时间戳 |

**db.js 导出的函数：**
```js
upsertContact({ wxid, name, avatar })       // 插入或更新联系人（ON CONFLICT UPDATE）
getContacts()                                // 所有联系人，按 last_time DESC
getContactByWxid(wxid)                       // 按 wxid 查
updateContactNotes(contactId, notes)
setPendingSuggestion(contactId, value)       // value: true/false
insertMessage({ contactId, content, isSelf, timestamp, type })  // 同时更新 last_message/last_time
getRecentMessages(contactId, limit=200)      // 按时间戳 DESC 取，然后 reverse（返回正序）
resetAiSession(contactId)                    // 删旧 session + ai_messages，重建新 session
getAiSession(contactId)
insertAiRound({ sessionId, analysis, candidates })
insertUserFollowup({ sessionId, content })
getFullAiSession(contactId)                  // 返回 { session, messages[] }，messages 已解析 JSON
```

---

## AI 模块（ai.js）

**对外导出：**
```js
generateSuggestions(contactId, chatHistory, { onChunk, onComplete, onError }, notes)
followUp(contactId, userText, { onChunk, onComplete, onError })
cancelRequest(contactId)
resetSession(contactId)   // 内部用，server.js 不直接调
```

**回调：**
- `onChunk(text)` — 流式时每块触发，text 是已解析的纯文本（JSON 外壳已剥离）
- `onComplete(result)` — `result = { message: string, candidates: string[] }`
- `onError(err)` — 主动 abort 不触发

**关键设计细节：**

1. **in-memory sessions Map**：`Map<contactId, { chat, abortController }>`，重启后清空
2. **generateSuggestions** 调用时：先 abort 旧请求 → 重建 Gemini chat 对象（`resetSession`）→ 发送消息
3. **followUp** 调用时：先检查内存里有没有 session，没有则调 `restoreSession()` 从数据库重建 → 只 abort 旧请求，保留 chat
4. **restoreSession**：从 `db.getFullAiSession()` 读历史，把 ai_round → model turn、user → user turn 重建 Gemini history。最后一条必须是 model 才恢复，否则返回 null
5. **流式 JSON 解析**：Gemini 用 `responseSchema` 强制输出 JSON，流式时会先输出 `{"message": "` 等外壳。`_streamingRequest` 内部实时扫描 buffer，只把 `message` 字段的值作为 chunk 发出（处理转义字符），`candidates` 在 `onComplete` 里从完整 buffer 解析
6. **responseSchema**：强制 `{ message: string, candidates: string[] }`，`responseMimeType: 'application/json'`

**发给 Gemini 的 user message 格式：**
```
【关于这个人】
{notes}

以下是我们最近的聊天记录：

她: ...
我: ...
她: ...

请分析当前对话情况并给出 N 条候选回复。
```

---

## server.js — HTTP 路由

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 返回 index.html |
| GET | `/settings` | 返回 settings.html |
| GET | `/import` | 返回 import.html |
| GET | `/api/contacts` | 联系人列表（按 last_time DESC） |
| GET | `/api/contacts/:id/messages` | 聊天记录（`?limit=200`，默认 200） |
| GET | `/api/contacts/:id/ai-session` | 当前 AI session 完整内容（含 messages[]） |
| POST | `/api/contacts/:id/followup` | 追问（body: `{ text }`） |
| POST | `/api/contacts/:id/read` | 清除红点（has_pending_suggestion = 0） |
| POST | `/api/contacts/:id/notes` | 更新联系人备注（body: `{ notes }`） |
| POST | `/api/import` | 批量导入聊天记录（body: `{ wxid, otherName, messages: [{content, isSelf}] }`） |
| POST | `/api/mock/message` | 注入单条消息（body: `{ wxid, name, content, isSelf, noAi }`） |
| POST | `/api/mock/trigger` | 手动触发 AI 生成（body: `{ contactId }`） |
| GET | `/api/settings` | 读取 config.yaml（含 API Key，生产环境应限制 IP） |
| POST | `/api/settings` | 保存 config.yaml（合并 server 字段，不覆盖 certPath 等） |

**WebSocket 事件（服务端 → 所有客户端广播）：**
```js
{ type: 'message', contactId, message }          // 新消息入库
{ type: 'contacts_update' }                       // 联系人列表变化，前端重新拉取
{ type: 'ai_start', contactId }                   // AI 开始生成
{ type: 'ai_chunk', contactId, chunk }            // 流式 chunk（纯文本，非 JSON 外壳）
{ type: 'ai_complete', contactId, result }        // result = { message, candidates }
{ type: 'ai_error', contactId, error }            // 错误信息
```

**核心消息处理流程：**
```
wechat.receive() 或 Mock 注入
  → wechat.js 触发 'message' 事件
  → server.js: upsertContact + insertMessage + broadcast(message) + broadcast(contacts_update)
  → 如果 !msg.isSelf：triggerAi(contact)
      → db.getRecentMessages(200 条)
      → db.resetAiSession（删旧建新）
      → broadcast(ai_start)
      → ai.generateSuggestions()
          → 流式 chunk → broadcast(ai_chunk)
          → 完成 → db.insertAiRound + setPendingSuggestion(true) + broadcast(ai_complete) + broadcast(contacts_update)
          → 错误 → broadcast(ai_error)
```

**安全机制：**
- HTTPS：`config.yaml` 的 `server.certPath` / `server.keyPath` 有值时自动用 `https.createServer`
- IP 白名单：`server.allowedIPs` 数组，Express 中间件 + WebSocket 连接均检查，非白名单返回 403
- IPv4-mapped IPv6 处理：`req.ip` 可能是 `::ffff:1.2.3.4`，已自动去前缀

---

## PWA 和 Share Target

**安装条件**：HTTPS + manifest.json + Service Worker，Chrome 满足后在地址栏或 header 的 ⬇ 按钮安装。

**Share Target 流程：**
1. 安装 PWA 后系统分享菜单出现 "AI Copilot"
2. 微信多选消息 → 分享 → AI Copilot
3. 微信以 `multipart/form-data` POST 到 `/import`（manifest 中 `share_target.action`）
4. Service Worker 拦截该 POST，解析 formData（text 字段或 files 字段）
5. 文件内容读取为文本，存入 IndexedDB（key: `share` store）
6. 重定向到 `/import.html?from=share`
7. import.html 加载时从 IndexedDB 取出文本，自动触发解析

**注意**：微信在安卓不走标准系统分享（只有 `*/*` 类型接受才会出现）。manifest 的 `share_target.enctype` 必须是 `multipart/form-data`，files 的 `accept` 必须包含 `"*/*"`。

---

## 导入页面（import.html）

**微信聊天记录的实际格式（多选消息 → 分享）：**
```
wyongwei 和 古希腊掌管希腊奶的神 在微信上的聊天记录如下，请查收。

—————  2026-04-06  —————


古希腊掌管希腊奶的神  16:21

有点事，一会儿回

wyongwei  16:21

好的
```

规律：
- 头部包含"在微信上的聊天记录"
- 日期分隔线：`——— 2026-04-06 ———`（破折号）
- 发送者行：`发送者名  HH:MM`（两个以上空格分隔，时间在末尾）
- 消息内容：发送者行的下一个非空行

**解析器**：`parseWeChatLog()` 在 import.html 内，正则 `TIME_RE = /\s{2,}(\d{1,2}:\d{2})\s*$/` 匹配发送者行。

**自动识别"我"**：页面加载时调 `/api/settings` 获取 `my_name`，在 `parsed.names` 中查找匹配，匹配成功则跳过手动选择直接预览。

**导入 API**：`POST /api/import`，时间戳以 `now - (total - i) * 1000` 递增（保证顺序正确）。

---

## 前端主界面（app.js）

**布局**：三栏（联系人 / 聊天 / AI 助手），桌面端 ≥768px 并排，移动端单栏 + 底部 tab 切换。

**关键状态变量：**
```js
let contacts = [];           // 联系人列表缓存
let currentContactId = null; // 当前选中的联系人 id（Number）
let isStreaming = false;      // AI 是否正在流式输出（防重复操作）
let hasAiSession = false;     // 当前联系人是否有 AI session（控制追问框可用性）
let candidateOffset = 0;      // 候选回复的全局编号偏移（多轮追问时累计）
```

**AI 流式渲染：**
- `ai_start` → 清空面板、显示光标动画
- `ai_chunk` → `aiAnalysis.textContent += chunk`（chunk 已是纯文本）
- `ai_complete` → `renderCandidates()`，候选回复编号从 `candidateOffset+1` 开始

**追问渲染：**第一个 `ai_round` 作为主分析，后续 `ai_round` 和 `user` 类型追加到"追问记录"区域。

**Mock 栏：**
- "我发的"勾选时：用当前联系人的 wxid 发送，不触发 AI，name 字段隐藏
- "不触发AI"勾选时：`noAi: true`，消息只入库不走 AI
- 选中联系人时自动填充 Mock 栏的名字字段

**红点清除逻辑：**`selectContact()` 时如果 `contact.has_pending_suggestion`，立即更新本地状态重渲染，同时异步 `POST /api/contacts/:id/read`。

---

## 界面示意

```
┌──────────┬──────────────────────┬─────────────────────────┐
│  联系人   │     聊天记录          │   AI 助手       [⬇][⚙️]│
│  [搜索]  │                      │                         │
│ ● 小A ✦  │   小A: 梅岭，你也     │  AI 的分析和建议...     │
│   小B    │       喜欢爬山？      │  （流式逐字显示）        │
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

- `✦` 红点：`has_pending_suggestion = 1`，选中后自动清除
- `[⬇]`：PWA 安装按钮（`beforeinstallprompt` 触发后显示）
- 📋：复制按钮，只复制候选回复文本

---

## 部署（VPS）

```bash
git clone https://github.com/chie4hao/WeChat-AI-Copilot.git
cd WeChat-AI-Copilot
npm install
cp config.yaml.example config.yaml
# 编辑 config.yaml，填入 API Key、my_name、certPath/keyPath、allowedIPs
```

用 PM2 后台运行（推荐）：
```bash
npm install -g pm2
pm2 start src/server.js --name wechat-copilot
pm2 save && pm2 startup

# 更新代码
git pull && pm2 restart wechat-copilot
```

手动运行：
```bash
npm start        # node src/server.js
npm run dev      # node --watch src/server.js（开发模式，文件变更自动重启）
```

**安全建议**：
- 配置 `server.allowedIPs` 为你的代理出口 IP（通过 VPN/hysteria2 访问时，来源 IP 是 VPS 公网 IP，而不是 127.0.0.1）
- 证书配置好后通过 HTTPS 访问，/api/settings 会返回 API Key，务必限制 IP
- PWA 安装后卸载重装才能更新 Share Target 注册

---

## 注意事项 & 常见坑

- **ESM only**：所有文件用 `import/export`，不用 `require()`。`@google/genai` 是 ESM only，这是最初转 ESM 的原因
- **`config.yaml` 不提交 git**：含 API Key，`.gitignore` 已排除
- **`data.db` 不提交 git**：`.gitignore` 已排除
- **`contactId` 类型**：数据库返回 Number，WebSocket 事件中也是 Number，前端比较时注意不要用字符串
- **settings 保存合并逻辑**：`POST /api/settings` 用 `Object.assign({}, current.server, incoming.server)` 合并，certPath 等不会被前端表单覆盖丢失
- **better-sqlite3 Windows 安装失败**：换 `sql.js`（异步 API，需要改 db.js）
- **WeChatFerry**：只能跑在 Windows，需要特定版本微信，有封号风险（低优先级，暂不实现）
- **PM2 启动路径**：config.js 用 `__dirname` 定位 config.yaml，与 PM2 从哪个目录启动无关
