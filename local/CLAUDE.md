# WeChat AI Copilot 本地端（local/）

在装有微信桌面版和 WeChatDataAnalysis（WCDA，2.3.0+，开启实时模式）的 Windows 电脑上常驻运行，
把微信新消息上报到 VPS 服务端（`POST /api/sync`），并每分钟上报心跳（`POST /api/bridge/heartbeat`）。
config.yaml、sync_state.json、session_sig.json、image_cache.json、pending_queue.json、logs/ 都是运行时数据，已 gitignore；
`HAKUREI_DATA_DIR` 可以把它们指到别处（测试用）。

## 运行

```
npm start                    # 前台运行，日志同时打到控制台和 logs/bridge-YYYY-MM-DD.log
npm run service:install      # 注册 Windows 计划任务：登录后 30s 隐藏启动，崩溃自动重启
npm run service:status       # 计划任务 / 监督进程 / node 进程 / 最近日志
npm run service:stop | service:start | service:uninstall
```
service/ 的结构：Windows 计划任务 → `start_bridge.vbs`（隐藏窗口，等待并返回退出码）→ `supervisor.ps1` → node。
VBS 必须保持运行，让计划任务的 Running 状态覆盖守护进程的生命周期。Windows 每分钟触发一次检查，正常运行时 IgnoreNew 不创建重复实例，退出后重新拉起；同时保留失败重试设置。
node 退出由守护进程等待 5 秒再启动，10 秒内崩溃则等 30 秒；项目目录互斥锁防止重复实例，pid 写在 bridge.pid。
`service:start` 优先使用 Start-ScheduledTask，让 Windows 服务创建进程，避免继承终端或 Codex 的进程作业，随宿主退出被清理。
`service:stop` 先暂停计划任务（包括自启和周期检查），再按本项目完整脚本路径清理进程；`service:start` 重新启用任务。不能全局匹配 `src/index.js` 杀 node。
改了 src 后 `service:stop` 再 `service:start`；更改计划任务设置后运行 `service:install`。
2026-09-10 的离线故障：心跳在 17:12 中断，守护进程和 node 同时消失，Codex 于 17:12:41 重启；旧的直接后台启动可能随宿主一起被清理，旧任务又没有守护进程失败恢复。

## 文件

| 文件 | 作用 |
|------|------|
| src/index.js | 入口：装文件日志、起 SyncClient、把 bridge 事件交给它、每分钟心跳、信号处理 |
| src/wechat_bridge.js | 监听 WCDA：SSE 变更事件 → 拉会话列表 → 只对指纹变化的联系人拉消息 → 转成统一格式；`getStatus()` 供心跳 |
| src/sync_client.js | 上报 VPS：/api/sync、心跳、失败重试队列落盘、413 拆分；fetch 可注入，便于测试 |
| src/image_analyzer.js | 图片描述 / 语音转写（Gemini），成功结果缓存到 image_cache.json，失败不缓存 |
| src/sync_state.js | 每个联系人的同步进度：`{ fullSynced, lastCreateTime, keysAtLastTime, lastLocalId }`，其中 localId 仅作诊断 |
| src/message_identity.js | 完整消息标识：精确的 serverId 字符串优先，回退到 WCDA 的库:表:行 ID；比较时间游标及同秒消息 |
| src/logger.js | console 同时写按天日志，保留 14 天 |
| src/paths.js | 数据目录定位 |
| src/config.js | 读 config.yaml |
| test/ | `npm test`：convert（消息转换）、poll（指纹比对与增量判定，用假 WCDA）、sync_client（上报与队列） |
| test/service.test.ps1 | `npm run test:service`：Windows 隔离计划任务与虚拟 Node，验证启动、重复启动、node/守护进程崩溃恢复、精确停止及停止后不重启（约 3 分钟） |

## 关键机制

- **检测新消息**：不再逐个会话轮询。WCDA 的 `/api/chat/realtime/stream` 在 message/session 库有写入时推 SSE 事件，
  桥接收到后拉一次 `/api/chat/sessions`，对比每个会话的 lastMessage / lastMessageTime / unreadCount 指纹，
  只对变化的联系人调 `/api/chat/messages`（这个接口单次要 3~18 秒，是最贵的调用）。
  SSE 正常时每 heartbeat_ms 兜底拉一次会话列表；SSE 断开时每 poll_interval_ms 拉一次。
- **WCDA messages 分页语义**：realtime 模式 offset 从最新一条往旧数，order=asc 只是把那一页反转。
- **指纹落盘与补漏**：每轮比对后把指纹写到 session_sig.json（含保存时间）。重启时先载入，第一轮就能发现停机期间有变化的联系人；
  完全没有指纹文件（首次运行）时只建基线，同时把已跟踪的联系人排进后台补漏队列，在没有事件要处理时逐个核对 lastLocalId，
  每个间隔 3 秒；之后每 `catchup_interval_hours`（默认 6）小时再核对一遍，兜住"同一分钟同样预览"这类指纹比对漏掉的情况。
  2026-09-04 曾因停机 1 小时 + 启动只建基线漏掉 3 条消息，就是这个机制补的。
- **首次见到的联系人**：没有 lastLocalId，用消息 createTime 与上一轮快照时间比较，只把更新的当新消息。
- **首次收到对方消息**：先全量拉取该联系人的历史（isFullSync=true，VPS 只入库不触发 AI），再上报新消息触发 AI。
- **触发规则**：system（撤回提示等）和 voip 类型即使 isSent=false 也不算对方来消息；VPS 端同样按 renderType 排除。
- **去重**：每条消息带 messageKey、localId 和 createTime（秒），VPS 端优先按完整 messageKey 去重。localId 只在单个库/表内唯一，微信换库后会重置，不能用它判断消息新旧。增量同步用时间和该秒已处理的消息标识；分页必须越过游标所在整秒。上报成功或失败批次落盘后才推进进度和会话指纹。旧状态没有时间游标时，首次核对保守重放历史，由服务端去重。
- **已读位置**：lastLocalId 在消息处理并上报之后才推进；上报失败进 pending_queue.json，30 秒重试，413 时对半拆分。

## 消息转换（_convert）

text 原样；image → Gemini 描述；voice → 微信自带转写优先，否则 Gemini；quote 带引用；
system → `[系统消息] ...`，文案以"你"开头视为自己的动作；link → `[链接：标题]`；chatHistory → 标题 + 摘要；
emoji/video/file/location/transfer → 带信息的占位；voip 跳过。

## 常见坑

- WCDA 必须处于实时模式（设置里点闪电图标），否则 sessions 接口会回退到解密快照（响应里 `sourceFallback=true`，桥接会记到状态里并提示一次），SSE 接口返回 400。
- WCDA 没开时，轮询改为每 30 秒重试一次并只提示一次，SSE 重连日志每 10 次打一条；恢复后自动回到正常节奏。
- 桥接与 WCDA 前端共用一个后端，后端对 WCDB 的调用是串行的，同时开着聊天页会让接口更慢。
- `@google/genai` 用的是 0.7.0（VPS 端是 1.x），API 兼容，但升级前先测。
