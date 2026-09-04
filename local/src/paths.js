import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 运行时数据目录：config.yaml、sync_state.json、image_cache.json、pending_queue.json、logs/
 * 默认就是 local/ 本身；设置 HAKUREI_DATA_DIR 可以改到别处（测试、或一台电脑跑多个实例）。
 */
export const DATA_DIR = process.env.HAKUREI_DATA_DIR || path.join(__dirname, '..');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
export const dataFile = (name) => path.join(DATA_DIR, name);
