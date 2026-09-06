'use strict';
// 数据模型与持久化（05 §4）：Settings / OperationRecord，备份 manifest 列举。
const path = require('node:path');
const fs = require('node:fs');
const { dataRoot, readJSON, atomicWriteJSON, uuid } = require('./lib');

const SETTINGS_SCHEMA = 1;

function defaultSettings() {
  return {
    schemaVersion: SETTINGS_SCHEMA,
    locale: 'zh-CN',
    theme: 'system',
    selectedProfile: 'workbuddy-cn',
    autoBackup: { enabled: true, frequency: 'daily', retention: 3 },
    telemetry: { enabled: false },
    privacy: { scanOnExplicitSend: true },
  };
}

function loadSettings(root) {
  root = root || dataRoot();
  const s = readJSON(path.join(root, 'settings.json'));
  if (!s || s.schemaVersion !== SETTINGS_SCHEMA) {
    const merged = Object.assign(defaultSettings(), s || {});
    merged.schemaVersion = SETTINGS_SCHEMA;
    return merged;
  }
  return s;
}

function saveSettings(root, settings) {
  root = root || dataRoot();
  settings.schemaVersion = SETTINGS_SCHEMA;
  atomicWriteJSON(path.join(root, 'settings.json'), settings);
  return settings;
}

function createOperation(root, type) {
  root = root || dataRoot();
  const id = uuid();
  const rec = {
    schemaVersion: 1,
    operationId: id,
    type,
    status: 'queued',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    requestId: null,
    errorCode: null,
    redactionVersion: 1,
  };
  atomicWriteJSON(path.join(root, 'runtime', 'operations', `${id}.json`), rec);
  return rec;
}

function updateOperation(root, id, patch) {
  root = root || dataRoot();
  const p = path.join(root, 'runtime', 'operations', `${id}.json`);
  const rec = readJSON(p);
  if (!rec) return null;
  Object.assign(rec, patch);
  if (patch.status && patch.status !== 'queued' && patch.status !== 'running') {
    rec.finishedAt = new Date().toISOString();
  }
  atomicWriteJSON(p, rec);
  return rec;
}

function getOperation(root, id) {
  root = root || dataRoot();
  return readJSON(path.join(root, 'runtime', 'operations', `${id}.json`));
}

function listBackups(root) {
  root = root || dataRoot();
  const dir = path.join(root, 'backups', 'manifests');
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJSON(path.join(dir, f)))
      .filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = {
  SETTINGS_SCHEMA,
  defaultSettings,
  loadSettings,
  saveSettings,
  createOperation,
  updateOperation,
  getOperation,
  listBackups,
};
