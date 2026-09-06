'use strict';
// 客户端 profile 适配（02 / 03）。客户端名称不硬编码进 UI 业务逻辑。
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const PROFILES = {
  'workbuddy-cn': { id: 'workbuddy-cn', name: 'WorkBuddy 国内版', bundleHint: ['WorkBuddy'], cdpDefaultPort: null },
  'workbuddy-ai': { id: 'workbuddy-ai', name: 'WorkBuddy AI 国际版', bundleHint: ['WorkBuddy AI'], cdpDefaultPort: null },
};

function listProfiles() {
  return Object.values(PROFILES);
}

function getProfile(id) {
  return PROFILES[id] || null;
}

// 尽力探测本机已安装的 profile（不读取账号内容）。
function detectProfiles() {
  const found = [];
  const home = os.homedir();
  const roots = [
    path.join(home, 'Library', 'Application Support'),
    path.join(home, 'AppData', 'Roaming'),
    path.join(home, '.config'),
  ];
  for (const r of roots) {
    for (const id of Object.keys(PROFILES)) {
      const p = path.join(r, PROFILES[id].bundleHint[0]);
      try {
        if (fs.existsSync(p)) found.push(id);
      } catch {
        /* ignore */
      }
    }
  }
  return found;
}

module.exports = { PROFILES, listProfiles, getProfile, detectProfiles };
