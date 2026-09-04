// 测试公共辅助：每个测试文件在独立进程里跑（node --test），这里为它准备临时目录、临时配置与临时数据库。
// 必须在 import ../src/* 之前调用，因为 config.js / db.js 在模块加载时读取环境变量。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function setupTempEnv({ config = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-test-'));
  process.env.COPILOT_DB_PATH = path.join(dir, 'data.db');
  process.env.COPILOT_CONFIG_PATH = path.join(dir, 'config.yaml');
  writeConfig({
    my_name: '测试者',
    timezone: 'Asia/Shanghai',
    gemini: { api_key: 'test-key', model: 'gemini-2.5-flash', candidate_count: 3, temperature: 0.9, stream: true },
    server: { port: 0, sync_secret: 'test-secret' },
    prompt: '你是测试用的聊天参谋。',
    ...config,
  });
  return dir;
}

export function writeConfig(obj) {
  // 手写 YAML 会有转义坑，直接用 JSON：YAML 是 JSON 的超集
  fs.writeFileSync(process.env.COPILOT_CONFIG_PATH, JSON.stringify(obj, null, 2), 'utf8');
}
