# WeChat AI Copilot

## 项目目标

在微信聊天时，AI 自动监听消息，给出回复建议（含分析思路），由**人工审核后手动发送**。支持追问调整。计划做成开源项目发布。

---

## 核心交互流程

```
对方发微信消息
    → WeChatFerry 监听到消息（开发阶段用 Mock 模拟）
    → 存入 SQLite 数据库
    → 若当前有 AI 请求进行中 → 立即取消（AbortController.abort()）
    → 自动调用 Gemini API：传入系统 prompt + 近期聊天记录
    → 流式生成「分析段 + N 条候选回复」，WebSocket 实时推送到浏览器
    → 用户可追问（同一 chat session，Gemini 记住当前这轮候选）
    → 追问结果追加在下方，不覆盖之前的候选
    → 用户满意后手动复制去微信发送
    → 对方再发新消息 → 取消当前请求 → 重置 chat session → 重新生成
```

---

## 消息打断规则

| 触发场景 | 处理方式 |
|---------|---------|
| AI 初次生成中，对方发新消息 | 取消当前请求，以新的完整聊天记录重新发起 |
| 追问进行中，对方发新消息 | 取消追问请求，重置整个 AI session，重新生成 |
| 切换联系人 | 加载该联系人已有的 AI session 结果，不重新触发 |

---

## AI 请求的两层对话结构

**第一层：微信聊天记录（上下文，每次整体传入）**

每次 AI 请求都将近期微信聊天记录完整拼入 prompt，不依赖 Gemini 的跨请求记忆。

**第二层：追问 session（多轮，Gemini 记住当前这轮候选）**

- 初次请求 → AI 给出分析 + 候选 1/2/3
- 追问「太正式了」→ AI 基于上下文给出候选 4/5/6（追加，不覆盖）
- 对方发新消息 → 该 session 重置，开始全新一轮

---

## AI 输出格式

每次触发返回结构化 JSON（`responseMimeType: "application/json"`）：

```json
{
  "message": "AI 自由发挥的分析和建议，像朋友聊天一样说，包含情绪分析、建议方向、理由等，不限格式和长度。",
  "candidates": [
    "梅岭去过几次，风景怎样",
    "哈，累成啥样了",
    "喜欢，你是第一次去吗"
  ]
}
```

- `message`：AI 的自由发挥分析，供用户理解背景和理由
- `candidates`：纯回复文本，长短根据情况判断，无字数限制，用于复制按钮
- 追问后追加新的一组，旧的保留可向上翻看

---

## 界面设计

```
┌──────────┬──────────────────────┬─────────────────────────┐
│  联系人   │     聊天记录          │   AI 助手          [⚙️] │
│  [搜索]  │                      │                         │
│ ● 小A ✦  │   小A: 梅岭，你也     │  💭 分析                │
│   小B    │       喜欢爬山？      │  她在表达疲惫，试探      │
│   小C    │   我: （未回复）      │  共同爱好...             │
│          │                      │                         │
│          │                      │  [1] 梅岭去过几次    📋  │
│          │                      │  [2] 哈，累成啥样了  📋  │
│          │                      │  [3] 喜欢，第一次去？📋  │
│          │                      │                         │
│          │                      │  ── 追问记录 ──          │
│          │                      │  我: 太正式了轻松点      │
│          │                      │  💭 更口语化一点...      │
│          │                      │  [4] 哈哈累坏了吧    📋  │
│          │                      │  [5] 值不值，好玩吗  📋  │
│          │                      │                         │
│          │                      │  [追问输入框    ] [发送] │
├──────────┴──────────────────────┴─────────────────────────┤
│  Mock｜[对方 ▼] [输入消息...       ] [发]  [手动获取建议]  │
└────────────────────────────────────────────────────────────┘
```

- `✦` 角标：该联系人有未处理的 AI 建议
- `[⚙️]`：点击进入设置页面
- `[手动获取建议]`：不需要对方发新消息，直接基于当前聊天记录触发 AI
- AI 面板随联系人切换，各自保留独立的 session 状态

---

## 设置页面

独立页面（点击 ⚙️ 跳转），包含：

- Gemini API Key
- 模型选择（gemini-2.0-flash / gemini-1.5-flash / gemini-1.5-pro 等）
- 候选回复数量（默认 3，可调整）
- System Prompt 编辑器（大文本框）
- 保存按钮

---

## Mock 模式（开发调试用）

界面底部固定展示 Mock 输入栏：

- 下拉选择角色：「对方」或「我」
- 输入消息内容后点「发」：模拟该消息进入聊天记录
- 只有「对方」发消息才自动触发 AI 建议
- 「手动获取建议」按钮：不依赖新消息，直接触发 AI

Windows 生产环境将 Mock 栏替换为 WeChatFerry 真实监听，其余逻辑不变。

---

## 技术栈

| 模块 | 技术 |
|------|------|
| 微信接入 | WeChatFerry Node.js SDK（Windows）/ Mock EventEmitter（开发） |
| 后端 | Node.js + Express |
| 实时推送 | WebSocket（ws 库），流式 chunk 逐块转发 |
| AI | `@google/genai`（新版 SDK），`chat.sendMessageStream()` |
| 数据库 | better-sqlite3（有预编译二进制，通常无需额外编译环境） |
| 前端 | 原生 HTML/CSS/JS，不用框架 |
| 配置 | config.yaml + js-yaml（不提交 git） |

---

## 项目结构

```
wechat-ai-copilot/
├── src/
│   ├── wechat.js        # WeChatFerry 监听 / Mock EventEmitter
│   ├── ai.js            # Gemini 封装（流式、AbortController、多轮追问）
│   ├── db.js            # SQLite 数据库操作
│   ├── server.js        # Express + WebSocket，串联各模块
│   └── config.js        # 读取 config.yaml
├── public/
│   ├── index.html       # 主界面
│   ├── settings.html    # 设置页面
│   ├── app.js           # 前端逻辑
│   └── style.css
├── config.yaml          # 用户配置（gitignored）
├── config.yaml.example  # 配置模板
├── CLAUDE.md            # 项目说明（本文件，Claude Code 自动加载）
└── package.json
```

---

## 数据库结构

**contacts**（联系人）
- id, wxid, name, avatar, last_message, last_time, has_pending_suggestion

**messages**（消息记录）
- id, contact_id, content, is_self, timestamp, type

**ai_sessions**（AI session）
- id, contact_id, trigger_message_id, created_at
- 关联 ai_rounds（每轮分析 + 候选）和 followup_messages（追问记录）

---

## 开发顺序

1. `db.js` — 数据库初始化和基础操作
2. `wechat.js` — Mock EventEmitter
3. `ai.js` — Gemini 封装（含 AbortController、多轮追问、流式）
4. `server.js` — Express + WebSocket
5. 前端主界面
6. 设置页面

---

## 当前进度

- [x] 需求梳理完成
- [ ] 编码开始

---

## 默认 System Prompt

```
你是我的聊天参谋，帮我想回复思路。

【关于我】
31岁男，南昌，体制内程序员。话不多，不太会主动找话题。
谈过一段恋爱，经验不多。
爱好：钢琴、爬山越野跑、骑车。
性格：真诚，不油腻，不擅长甜言蜜语。

【回复要求】
- 先简短分析对方当前消息的意图/情绪/机会点（2-3句）
- 再给 {candidate_count} 条候选回复，每条不超过20字
- 语气像正常人发消息，简短自然
- 绝对不能油腻、不能堆感叹号
- 如果当前对话不需要回复，直接说「建议不回」或「等她说」
- 不要解释为什么这样回，直接给回复内容

【当前对话】
{chat_history}
```

---

## 注意事项

- WeChatFerry 只能运行在 **Windows** 上（注入PC端微信客户端）
- 使用第三方微信客户端违反微信服务条款，有封号风险，自行权衡
- WeChatFerry 需要特定版本微信，不能随意升级
- `config.yaml` 不提交 git
- `better-sqlite3` 在 Windows 安装失败时，换 `sql.js`
- Gemini SDK 包名是 `@google/genai`（新版），不是旧版的 `@google/generative-ai`
