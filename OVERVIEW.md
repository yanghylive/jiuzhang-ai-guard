# JIUZHANG AI 管家（JZ AI Guard）实现概览

> 基于内部开发文档规格全量实现。
> 定位：WorkBuddy 桌面工作台的本地守护工具，主体纯 Node.js 22 内置模块（运行时仅 ws 一个依赖）。
> 状态：2026-08-24 实现完成；**2026-08-30 第十一轮复核修复后 `node --test` macOS 293 total / 288 pass / 5 skip + Linux 非 root 288/288 + Windows 真机 junction 回归 292 pass / 0 fail 全绿 + 安全门禁 6/6 + 真实启动冒烟通过**（含 P0 本地铸券移除、entitlement HMAC 防伪、凭据迁移无明文残留、硬编码导出密码移除、JZVAULT 空密码 fail-closed、null Origin 拒绝、daemon 启动 TDZ 崩溃修复、符号链接防护（blob/restore/accounts）、Windows 账号密钥 DPAPI、备份路径 POSIX 归一等），macOS/无影云 Win11/Kaypal 真实 E2E 已跑。
> **未完成**：真实桌面会话（非 SYSTEM）默认路径装机 + apply 替换、CI 三平台徽章、kaypal refresh 401 契约。CI 门禁 + 安全 lint 已建（`.github/workflows/ci.yml`）。

## 运行方式
```bash
cd jz-ai-guard
npm start                 # 启动守护进程（127.0.0.1:18755，可用 JZ_DAEMON_PORT 覆盖）
# 或自定义数据根 / CDP 端口：
JZ_DATA_ROOT=/path JZ_CDP_PORT=9222 node scripts/daemon.js
npm test                 # node --test test/*.js
```
打开 `http://127.0.0.1:18755/` 即本地管理页。

## 模块与职责（scripts/）
| 文件 | 职责 |
|---|---|
| `daemon.js` | HTTP 服务、生命周期、协调，仅绑 127.0.0.1 |
| `api.js` | 本地 API 路由表（04 契约逐条实现，写操作幂等、服务端重校验） |
| `admin-ui.js` | 本地管理页 HTML（状态展示 + 收集确认，不持 token） |
| `health-check.js` | 只读体检、评分、规则顺序、前层失败后续 not_checked（03 §3） |
| `repair-actions.js` | 修复动作白名单、plan/run（03 §4） |
| `backup-vault.js` | 备份/校验/预览/恢复/导出(JZVAULT)/导入，AES-256-GCM（06） |
| `crypto-vault.js` | AES-256-GCM + 密钥存储（macOS Keychain → 0600 文件密钥降级，非固定密钥） |
| `cleanup.js` | 仅扫描 JIUZHANG AI 管家 自有目录；客户端只交 ID，服务端白名单重校验 |
| `compatibility.js` | 版本/profile/特征只读探针 |
| `migrate.js` | 旧目录迁移（按 schemaVersion 逐版本，迁移前原子备份、失败回滚） |
| `uninstall.js` | 卸载（默认 dry-run，白名单路径删除 + launchd 卸载 + Keychain 清理） |
| `security-gate.js` | 安全 lint（禁 -noverify / shell 字符串命令 / AppleScript / CORS 头 / 硬编码密钥，CI 卡点） |
| `cdp-targets.js` | CDP 目标发现（HTTP /json/list）+ 真实 WebSocket 命令通道（CDPChannel：命令 id 匹配/10s 超时/断连 reject pending） |
| `profiles.js` | 国内版/国际版 profile 适配 |
| `kaypal-license.js` | 真实端点 `POST /api/v1/app-entitlements/check`（已真机验证）+ device-code OAuth 桩 + entitlements 状态机 + 离线缓存降级 |
| `diagnostics.js` | 脱敏诊断包预览/上传（上传前字段预览+确认） |
| `oss-client.js` | 零依赖 OSS 客户端（node:crypto HMAC-SHA1 V1 签名 + https PUT，不引 ali-oss） |
| `error-report.js` | 报错自动上报（500 级 fire-and-forget + 限流 + redact 脱敏 → OSS error-reports/） |
| `publish.js` | 发版上传（release-build 产物 → OSS updates/jz-ai-guard/<version>/ + latest.json） |
| `build-release-app.js` | 构造发布 .app bundle（完整运行时脚本 + 可执行入口，排除开发工具） |
| `coupons.js` | 优惠券（本地实现：创建/兑换/幂等/防超兑，duration→延长本地 validUntil、balance→加余额） |
| `log-rotate.js` | 日志轮转（daemon 日志落盘 logs/daemon.log，超限轮转保留 N 份） |
| `inject.js` | WorkBuddy 渲染进程注入脚本（幂等、稳定 ID、浅/深色、防 XSS） |
| `storage.js` / `lib.js` / `redact.js` | 数据模型、基础工具、统一脱敏 |

## 验证结果
- `node --check scripts/*.js`：全过。
- `node --test test/*.js`：macOS **293 total / 288 pass / 5 skip** + Linux 非 root **288/288** + Windows 真机 **292 pass / 0 fail / 1 skip**（2026-08-30 第十一轮复核后基线；含 P0 防伪/凭据无明文、ID 校验、null Origin、符号链接/junction 逃逸、OSS multipart 签名、隐私盾 jsdom 行为、KCP 真实通道、Keychain、更新门禁等）。
- `node scripts/security-gate.js`：**6/6 PASS**（P1 防护在位，安全 lint 已并入 gate）。
- 真实启动：`127.0.0.1` 监听成功；无 WorkBuddy 时体检返回 `attention/score 74`（CDP_UNAVAILABLE 不误报）；备份可建；Kaypal 离线 → 503 `LICENSE_UNAVAILABLE`（优雅降级）。
- **CDP 真通道真机验证**：headless Chrome 151 @ 9223，discoverTargets→connect→Runtime.evaluate 1+1=2→UA 取证 HeadlessChrome/151→onEvent→close 清理 pending，全过。
- **DMG 真机构建 + 端到端安装门禁**：本机 hdiutil 出真实 DMG(71KB) + ed25519 签名 manifest + 固化发布公钥 → `decideInstallable installable:true` → `installVerified` 未签名包 `CODESIGN_FAILED` fail-closed 拒装。
- **商用冒烟 6/6**：更新流（codesign 拒装 fail-closed）、redact 端到端脱敏、daemon 鉴权三层全过。
- **诊断上报真验**：构造含 chat/token/cookie 的脏 operation → preview 产物零敏感值泄漏（白名单投影 + redact 兜底）。
- **Kaypal 会员联调**：服务器端建凭据 + 真拉 entitlement（status/plan/validUntil/balance 字段结构齐备，计费真实联动；样例值从略）。
- **Windows Authenticode 真机验证**（云电脑 Win11）：已签名 notepad.exe → Valid ok:true；错误指纹 → fail-closed；未签名 exe → NotSigned fail-closed。真机暴露并修复 2 个 bug（run 丢 env、Status 枚举序列化）。
- **账号备份/恢复全链路真机验证**（真实 `~/.workbuddy`）：6 个账号身份文件 → AES-256-GCM 加密备份 → 校验 → 恢复还原，不含登录 token。
- **发版 0.1.0（OSS）**：`publish.js` 上传 4 文件到 `updates/jz-ai-guard/0.1.0/` + latest.json；`fetchLatest` 自动更新检查真拉验证（检测 0.1.0 + 固化公钥验签 + upToDate）。

## 分域验收结论
- 02 §8 架构验收：依赖方向符合、UI 不直接读敏感文件、Kaypal 不进本地数据路径、本地 API 仅绑 loopback —— **通过**（桩部分见下）。
- 03 §7 模块验收：单职责、敏感操作仅 daemon、修复白名单可验证、重复注入不堆叠、事件统一脱敏 —— **通过**。
- 04 §9 API 验收：写操作幂等、长操作可查、路径/动作服务端重校验、错误不含敏感字段、与现有路由无冲突 —— **通过**（长操作进度查询为预留接口）。
- 05 §8 数据模型验收：schemaVersion、原子写、迁移前旧数据可恢复、互斥、manifest 不含敏感正文 —— **通过**（旧目录迁移为预留）。
- 06 保险箱：AES-256-GCM、唯一 nonce、错误密码统一失败、恢复不直接覆盖、JZVAULT 格式 —— **通过**。
- 07 对接验收：登录/刷新/断网/撤销/降级状态机 —— **逻辑与降级通过；真实联调需 Kaypal 测试环境**（见下）。
- 08 测试计划：静态/单测/E2E 用例 E2E-001~022 中**可本地验证部分已覆盖**；需真机/后端项见下。

## 仍为桩 / 需真机或后端才能真验（未假装验证）
- **Kaypal 设备码 OAuth**：kaypal 端无 device flow（仅 app credential + MCP OAuth authorization_code），设备码授权需 kaypal 后端新增；`requestDeviceCode`/`pollDeviceToken` 骨架保留 fail-closed。
- **Apple 代码签名 / 公证**：产品负责人决策不购 Developer ID；`codesign` + `notarize()` 骨架保留，无证书优雅跳过（更新完整性仍由 ed25519 签名 manifest 覆盖）。
- **会话内容目录备份**：`accounts`/`sessions` 作用域已接真实 WorkBuddy 身份/配置文件；会话 blob（`app/session/blob_storage` 等大目录）的递归目录备份为后续扩展。
