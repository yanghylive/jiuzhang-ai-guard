'use strict';

const crypto = require('crypto');
const { spawnSync } = require('child_process');
const tls = require('tls');

let cachedSystemCa;

function derToPem(base64) {
  const compact = String(base64 || '').replace(/\s+/g, '');
  if (!compact || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) return null;
  try {
    const der = Buffer.from(compact, 'base64');
    if (!der.length) return null;
    new crypto.X509Certificate(der);
    const encoded = der.toString('base64').match(/.{1,64}/g).join('\n');
    return `-----BEGIN CERTIFICATE-----\n${encoded}\n-----END CERTIFICATE-----`;
  } catch (_) {
    return null;
  }
}

function readWindowsSystemCa() {
  if (process.platform !== 'win32') return [];
  const command = "$ErrorActionPreference = 'Stop'; " +
    "$stores = @('Cert:\\LocalMachine\\Root', 'Cert:\\CurrentUser\\Root'); " +
    "Get-ChildItem -Path $stores -ErrorAction SilentlyContinue | " +
    "Where-Object { $_.RawData } | " +
    "ForEach-Object { [Convert]::ToBase64String($_.RawData) }";
  const options = {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 8 * 1024 * 1024,
  };
  for (const executable of ['powershell.exe', 'powershell']) {
    let result;
    try {
      result = spawnSync(executable, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command,
      ], options);
    } catch (_) {
      continue;
    }
    if (result.error || result.status !== 0) continue;
    const certs = [];
    const seen = new Set();
    for (const line of String(result.stdout || '').split(/\r?\n/)) {
      const pem = derToPem(line);
      if (pem && !seen.has(pem)) {
        seen.add(pem);
        certs.push(pem);
      }
    }
    return certs;
  }
  return [];
}

function systemCaCerts() {
  if (cachedSystemCa !== undefined) return cachedSystemCa;
  cachedSystemCa = readWindowsSystemCa();
  return cachedSystemCa;
}

function tlsCaOptions() {
  const system = systemCaCerts();
  if (!system.length) return {};
  const builtin = Array.isArray(tls.rootCertificates) ? tls.rootCertificates : [];
  const ca = [];
  const seen = new Set();
  for (const cert of builtin.concat(system)) {
    if (!seen.has(cert)) {
      seen.add(cert);
      ca.push(cert);
    }
  }
  return ca.length ? { ca } : {};
}

module.exports = { systemCaCerts, tlsCaOptions };
