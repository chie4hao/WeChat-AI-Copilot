import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '..', 'config.yaml');

let _config = null;

function load() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  _config = yaml.load(raw);
  return _config;
}

function get() {
  if (!_config) load();
  return _config;
}

function reload() {
  _config = null;
  return load();
}

function save(newConfig) {
  _config = newConfig;
  fs.writeFileSync(CONFIG_PATH, yaml.dump(newConfig), 'utf8');
}

export default { get, reload, save };
