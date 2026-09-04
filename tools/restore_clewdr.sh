#!/usr/bin/env bash
# 恢复 clewdr 反代的 /code 通道：
#   clewdr 0.12.26 靠 claude.ai cookie 走 OAuth 授权换取 Claude Code token，
#   老 cookie 会被 claude.ai 以 "Session is not fresh enough" 拒绝。
#   这里直接把 Copilot 配置里已经可用的 Claude Code OAuth token（claude setup-token 生成，
#   有效期一年）写进 clewdr 的 token 缓存，跳过授权步骤；然后测试反代，通过就把
#   Copilot 切回反代通道并用 test-ai.js 验证流式输出。
#
# 在本机运行（在 Claude Code 里输入以 ! 开头的这一行）：
#   ! ssh -i ~/.ssh/id_ed25519_hakurei root@80.251.220.25 'bash -s' < C:/github/Hakurei-Bot/restore_clewdr.sh
#
# 脚本本身不含任何密钥，全部在 VPS 上运行时读取。改动前会备份 clewdr.toml 与 config.yaml。
set -e
cd /root/clewdr
read_cfg() { (cd /root/WeChat-AI-Copilot && node -e 'import("js-yaml").then(y=>{const fs=require("fs");const c=y.default.load(fs.readFileSync("config.yaml","utf8"));process.stdout.write(String(eval(process.argv[1])||""))})' "$1"); }
TOKEN=$(read_cfg 'c.claude_code.oauth_token')
KEY=$(read_cfg 'c.claude.api_key')
[ ${#TOKEN} -gt 50 ] || { echo "oauth_token 读取失败"; exit 1; }
[ ${#KEY} -gt 10 ] || { echo "claude.api_key 读取失败"; exit 1; }
N=$(grep -c '^\[\[cookie_array\]\]' clewdr.toml)
[ "$N" = "1" ] || { echo "cookie_array 条目数=$N，不是 1，停止"; exit 1; }
BAK=clewdr.toml.bak-$(date +%Y%m%d-%H%M)
cp clewdr.toml "$BAK"; echo "clewdr.toml 已备份: $BAK"
EXPAT=$(( $(date +%s) + 365*86400 ))
pm2 stop clewdr >/dev/null && echo "clewdr 已停止"
# 已有的 token 段先删掉（token 到期后重新运行本脚本即可覆盖），再在 session_usage 前插入新的
awk -v tok="$TOKEN" -v expat="$EXPAT" '
  /^\[cookie_array\.token(\.organization)?\]$/ { skip = 1; next }
  /^\[/ { skip = 0 }
  skip { next }
  /^\[cookie_array\.session_usage\]/ && !done {
    print "[cookie_array.token]";
    print "access_token = \"" tok "\"";
    print "expires_in = 31536000";
    print "refresh_token = \"\"";
    print "expires_at = " expat ".0";
    print "";
    print "[cookie_array.token.organization]";
    print "uuid = \"\"";
    print "";
    done = 1
  }
  { print }' "$BAK" > clewdr.toml
echo "--- 写入后的 token 段（脱敏） ---"
grep -n -A8 '^\[cookie_array\.token\]' clewdr.toml | sed -E 's/(access_token = ".{12}).*/\1<hidden>"/'
pm2 start clewdr >/dev/null && sleep 3
pm2 list | grep clewdr
echo "--- 启动日志 ---"
pm2 logs clewdr --lines 6 --nostream 2>&1 | grep -v '^$' | sed -E 's/sk-ant-[A-Za-z0-9_-]{8}[A-Za-z0-9_-]*/sk-ant-<hidden>/g' | tail -6
echo "--- 测试 /code/v1/messages ---"
CODE=$(curl -s -m 120 -o /tmp/cc.json -w "%{http_code}" http://127.0.0.1:8484/code/v1/messages -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" -d '{"model":"claude-opus-5","max_tokens":20,"messages":[{"role":"user","content":"只回复两个字：收到"}]}')
echo "HTTP $CODE"; head -c 400 /tmp/cc.json; echo; rm -f /tmp/cc.json
echo "--- 请求后的 clewdr 日志 ---"
pm2 logs clewdr --lines 6 --nostream 2>&1 | grep -v '^$' | sed -E 's/sk-ant-[A-Za-z0-9_-]{8}[A-Za-z0-9_-]*/sk-ant-<hidden>/g' | tail -6
if [ "$CODE" = "200" ]; then
  echo "=== 反代可用，切回 Copilot 的 Claude 反代通道 ==="
  cd /root/WeChat-AI-Copilot
  cp config.yaml config.yaml.bak-$(date +%Y%m%d-%H%M)-b
  node --input-type=module -e 'import fs from "fs"; import yaml from "js-yaml"; const c=yaml.load(fs.readFileSync("config.yaml","utf8")); c.claude_code={...(c.claude_code||{}),enabled:false}; fs.writeFileSync("config.yaml", yaml.dump(c)); console.log("claude_code.enabled -> false; base_url="+c.claude.base_url+" model="+c.claude.model+" effort="+c.claude.effort)'
  pm2 restart wechat-copilot >/dev/null; sleep 4
  curl -sk -m 10 https://127.0.0.1:3000/api/provider-status; echo
  echo "=== test-ai.js 走反代（流式） ==="
  timeout 200 node test-ai.js 2>&1 | grep -v "punycode\|trace-deprecation" | head -30
else
  echo "反代测试未通过，Copilot 保持 Claude Code 通道不变；如需回滚 clewdr：cp $BAK clewdr.toml && pm2 restart clewdr"
fi
