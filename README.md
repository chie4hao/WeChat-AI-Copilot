# WeChat AI Copilot

微信聊天的 AI 参谋：对方发来消息后，AI 自动分析对话并给出几条候选回复，你在手机上看一眼、改一改，再手动发出去。**AI 只是助手，人永远是最终决策者**，程序不会替你发送任何消息，也不挂钩微信客户端，没有封号风险。

```
 电脑（Windows）                                VPS                                    手机
 ┌────────────────────┐   HTTPS 上报     ┌─────────────────────────┐   PWA / 推送   ┌──────────┐
 │ 微信桌面版          │ ───────────────> │ WeChat AI Copilot 服务端 │ ───────────>  │ 看建议    │
 │  └ WeChatDataAnalysis│  local/ 本地端   │  Express + SQLite + AI   │               │ 复制回复  │
 │     （解密 + 实时接口）│                 │  Claude / Gemini         │               │ 手动发送  │
 └────────────────────┘                  └─────────────────────────┘               └──────────┘
```

## 功能

- **实时同步**：本地端订阅 [WeChatDataAnalysis](https://github.com/LifeArchiveProject/WeChatDataAnalysis) 的变更事件，新消息十秒内到达 VPS；图片由 Gemini 转成文字描述，语音优先用微信自带转写。
- **AI 建议**：对方来消息自动生成"局面分析 + 若干候选回复"，支持追问调整、以任意历史消息为节点复盘。
- **多种 AI 通道**：Claude Code 订阅（Agent SDK）、clewdr 反代（同样走订阅额度，支持逐字流式）、Claude 官方 API、Gemini API；设置页一键测试连接。
- **手机端 PWA**：可安装到桌面，AI 建议生成后 Web Push 推送，点通知直达该联系人；也支持把微信"多选消息 → 分享"直接导入。
- **人物档案**：给每个联系人写备注，AI 会参考；黑名单 / 白名单控制哪些人触发。
- **系统状态卡**：主页一眼看到本地端心跳、WCDA 实时模式、事件流、待重传、AI 通道与上次生成结果；本地端掉线自动推送提醒。
- **本地端开机自启**：一条命令注册为 Windows 计划任务，崩溃自动重启，日志按天切割。

## 快速开始

### 1. VPS 服务端

需要一台能被手机访问的服务器（Node.js 20+）。首次部署：

```bash
git clone https://github.com/chie4hao/WeChat-AI-Copilot.git
cd WeChat-AI-Copilot
bash tools/deploy_vps.sh        # 装依赖、生成 config.yaml、用 pm2 常驻
```

然后编辑 `config.yaml`：

| 字段 | 说明 |
|------|------|
| `my_name` | 你的微信昵称，导入聊天记录时用来识别哪条是你发的 |
| `server.port` / `certPath` / `keyPath` | 端口与证书；有证书自动启用 HTTPS（PWA 安装与推送都需要 HTTPS） |
| `server.sync_secret` | 本地端上报用的口令，本地端 `vps.secret` 要填一样的 |
| `server.allowedIPs` | IP 白名单。设置接口会返回全部密钥，**务必限制** |
| `server.vapid_*` | Web Push 密钥，`npx web-push generate-vapid-keys` 生成 |
| `claude_code` / `claude` / `gemini` | AI 通道，见下一节 |
| `skip_names` / `only_names` | 黑名单 / 白名单关键词 |
| `timezone` | 拼给 AI 的时间所用时区，默认 `Asia/Shanghai` |
| `bridge_offline_minutes` | 本地端多少分钟没心跳算离线，默认 10 |
| `prompt` | 系统提示：你的人设和回复要求 |

之后更新：`bash tools/update_vps.sh`。

### 2. 选择 AI 通道

设置页（`/settings`）里从上到下三层，上层启用则覆盖下层，顶部状态条会告诉你**当前实际生效的是哪条**，旁边有"测试连接"按钮：

| 通道 | 计费 | 怎么配 | 特点 |
|------|------|--------|------|
| ① Claude Code | Max 订阅额度 | 本地电脑 `claude setup-token` 生成 token 填入 | 免 API 费；没有逐字流式，界面转圈直到完成 |
| ② clewdr 反代 | Max 订阅额度 | VPS 上跑 [clewdr](https://github.com/Xerxes-2/clewdr) ≥ 0.13.5，接入方式选"clewdr 反代"，填反代密码 | 免 API 费，有流式和提示词缓存；依赖 ① 的 token，见下方 FAQ |
| ② 官方 API | 按 token | 接入方式选"官方 API"，填 `sk-ant-api...` | 最省心 |
| ③ Gemini | 按 token | 填 Gemini API Key | 兜底；本地端的图片描述也用它 |

模型可选 claude-fable-5-1 / claude-opus-5 / claude-sonnet-5 等，思考深度 low 到 max 可调。

### 3. 本地端（Windows 电脑）

前提：电脑上登录着微信桌面版，并安装 [WeChatDataAnalysis](https://github.com/LifeArchiveProject/WeChatDataAnalysis) 2.3.0 以上，在它的侧边栏点闪电图标开启**实时模式**。

```powershell
cd local
npm install
copy config.yaml.example config.yaml     # 填 VPS 地址、secret、Gemini key
npm start                                # 前台运行，看日志
npm run service:install                  # 或者：注册为登录自启的后台服务
```

服务相关命令：`npm run service:status` 看状态，`service:stop` / `service:start` 停止和启动，`service:uninstall` 取消自启。日志在 `local/logs/bridge-日期.log`。

### 4. 手机

用 Chrome 打开 VPS 地址，地址栏或页面右上角的 ⬇ 安装为 PWA；点铃铛开启推送通知。之后对方一发消息，手机就会收到"某某 — AI 建议"的通知。

## 主页状态卡

联系人列表顶部有一行状态：绿色表示本地端心跳正常、事件流在线；黄色表示需要留意（事件流断开改为轮询、有待重传、token 快到期）；红色表示链路断了（本地端离线、WCDA 没开或没开实时模式、AI 上次生成失败）。点开可以看到每一项的详情。

## 安全提醒

- `config.yaml` 含所有密钥，已在 `.gitignore` 里，不要提交。
- 服务端只有 IP 白名单一道门，`/api/settings` 会返回密钥明文，务必配置 `allowedIPs` 并使用 HTTPS。
- 本地端读取的是你自己电脑上已解密的微信数据，上报到你自己的 VPS，不经过任何第三方。

## 开发与测试

```bash
npm test                 # 服务端：数据库迁移与去重、AI 辅助函数、导入解析、HTTP 接口
npm --prefix local test  # 本地端：消息转换、会话指纹比对与增量判定、上报与重试队列
npm run test:all
```

测试用 Node 自带的 `node --test`，不需要额外依赖。代码结构与设计细节见 `CLAUDE.md` 和 `local/CLAUDE.md`。

## FAQ

**clewdr 反代返回 403 "Session is not fresh enough"？** clewdr 靠 claude.ai cookie 走 OAuth 授权换取 Claude Code token，而这一步要求会话是新登录的。绕过办法：把 ① 里可用的 OAuth token 直接写进 clewdr 的 token 缓存，在 VPS 上运行 `bash tools/restore_clewdr.sh`。token 一年后到期，主页状态卡会提前两周提醒。

**选 claude-fable-5-1 报 "version 2.1.251 or newer is required"？** 需要 clewdr ≥ 0.13.5（`./clewdr --update`）或 `@anthropic-ai/claude-agent-sdk` ≥ 0.3.260。

**状态卡说"WCDA 未开实时模式"？** 在 WeChatDataAnalysis 里点侧边栏的闪电图标；实时模式需要它的原生解密组件可用。

**消息同步慢？** WCDA 的消息接口单次要几秒，本地端只对会话列表指纹变化的联系人拉消息，正常情况下新消息十秒内到达。如果本地端在轮询模式（事件流断开），间隔取决于 `poll_interval_ms`。

## 致谢

- [WeChatDataAnalysis](https://github.com/LifeArchiveProject/WeChatDataAnalysis) 提供微信数据解密与实时接口
- [clewdr](https://github.com/Xerxes-2/clewdr) 提供 Claude 反代

## 许可

MIT
