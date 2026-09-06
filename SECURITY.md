# 安全策略

## 设计立场

- 守护进程仅绑定 `127.0.0.1`，写操作幂等且服务端重校验，访问需过令牌与 Origin 双门禁。
- 更新包逐个 sha256 + ed25519 验签，未签名一律拒装（fail-closed）。
- 备份与恢复在本机完成，加密使用 AES-256-GCM；备份不含登录 token 与聊天内容。
- 诊断包上传前逐字段预览脱敏，错误自动上报同样先过脱敏。
- CI 集成 `scripts/security-gate.js`：禁 `-noverify`、shell 字符串命令、AppleScript、CORS 放宽、硬编码密钥。

## 报告漏洞

请通过 GitHub 的 **Private vulnerability reporting**（Security → Report a vulnerability）私密报告，不要开公开 Issue。我们会在合理期限内回复确认与修复计划。

## 版本支持

安全修复面向当前发布版本（见 CHANGELOG 与最新 tag）。
