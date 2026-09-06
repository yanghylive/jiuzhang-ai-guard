# JIUZHANG AI 管家（jz-ai-guard）

[![CI](https://github.com/yanghylive/jiuzhang-ai-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/yanghylive/jiuzhang-ai-guard/actions/workflows/ci.yml)

九章智能（JIUZHANG AI）出品的 WorkBuddy 本地守护工具：只读体检、白名单修复、账号与配置加密备份、更新包验签。本仓库是其**源码公开快照**。

- 产品官网：jiuzhangai.cc ｜ 下载：官网「AI 管家」产品页
- 运行时要求：Node.js ≥ 18（macOS / Windows / Linux），**零第三方依赖**（全部 `node:` 内置模块）

## 它做什么

| 能力 | 说明 |
|---|---|
| 17 层只读体检 | 进程、CDP 连接、配置、备份等逐项给结论；全程只读，不动任何文件 |
| 9 类白名单修复 | 修复动作走白名单，先预览、经确认再执行，改坏可还原 |
| 加密保险箱 | 账号与配置 AES-256-GCM 备份/校验/恢复；备份不含登录 token 与聊天内容 |
| 更新门禁 | 更新包逐个做 sha256 + ed25519 验签，验不过就地拒装（fail-closed） |
| 本地管理页 | `127.0.0.1` 起 HTTP 服务与 UI；接口只绑回环地址，访问过令牌与 Origin 双门禁 |

与 WorkBuddy 等桌面工作台是**本机互操作关系**：本工具独立开发，不存在任何授权从属关系；互操作动作（CDP 连接、代点）在审计中逐条留痕，高风险动作需用户确认。

## 快速开始

```bash
npm install        # 仅 ws 一个依赖
npm start          # 启动守护进程（127.0.0.1:18755，JZ_DAEMON_PORT 可覆盖）
# 打开 http://127.0.0.1:18755/ 即本地管理页

JZ_DATA_ROOT=/path JZ_CDP_PORT=9222 node scripts/daemon.js   # 自定义数据根 / CDP 端口

npm test           # node --test 全量单测
npm run check      # 语法门禁
node scripts/security-gate.js   # 安全 lint（CI 同款卡点）
```

## 仓库结构

```
scripts/            守护进程与管理脚本
├─ daemon.js        HTTP 服务与生命周期（仅绑 127.0.0.1）
├─ jz/              核心模块：体检/修复/保险箱/验签/授权对账等（文件头有职责注释）
├─ inject.js        WorkBuddy 渲染进程注入脚本（幂等、防 XSS）
└─ security-gate.js 安全静态门禁
packages/pay-kit/   授权与支付对接参考实现（服务端模板）
test/               node:test 用例（无需外部测试框架）
assets/             图标与最终用户许可协议（EULA）
OVERVIEW.md         架构与验证记录
```

## 关于代码中的 "Kaypal" 命名

九章智能的前身与后端账号/计费服务使用 kaypal.cn 域名，代码中以 `kaypal-*` 命名的模块是与该授权计费后端的真实对接点。域名迁移进行中，源码命名保持现状以保证与线上服务一致。

## 许可与免责

- **本快照为源码公开，非 OSI 开源许可**：源码可供审阅、学习、评估；编译产物与应用本身受 [`assets/LICENSE.txt`](assets/LICENSE.txt)（EULA）约束；商业分发、再发布编译版需九章智能书面授权。
- 按 EULA 允许的方式在本机自行编译运行不违反协议；对第三方分发的限制以 EULA 为准。

## 安全

发现漏洞请按 [SECURITY.md](SECURITY.md) 私密报告。审计与修复相关敏感操作默认本机执行、需用户确认。
