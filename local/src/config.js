import { readFileSync, existsSync } from 'fs';
import { createRequire } from 'module';
import { dataFile } from './paths.js';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const CONFIG_PATH = dataFile('config.yaml');

function load() {
  if (!existsSync(CONFIG_PATH)) {
    console.error(`[config] 找不到 ${CONFIG_PATH}，请复制 config.yaml.example 并填写配置`);
    process.exit(1);
  }
  return yaml.load(readFileSync(CONFIG_PATH, 'utf8'));
}

export default { load, CONFIG_PATH };
