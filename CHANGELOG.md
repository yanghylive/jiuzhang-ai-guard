# Changelog

本仓库所有值得记录的变更，按时间倒序。版本号与 `package.json` 同步。

## [1.0.4] - 2026-09-03

### 新功能（邀请好友闭环）
- 设置新增「邀请好友」分类页：展示专属邀请链接/二维码/邀请码 + 一键复制 + 邀请计数（AI 算力券先计数，九章算力站上线后抵现金）；三态 fail-closed（未登录引导 / token 过期提示 / 接口失败降级，不放假数据）
- daemon 新增 `GET /api/license/coupon/invite-count`，转发 kaypal `referral/mine`（desktop-auth Bearer），未登录 401 / 失败 502

## [Unreleased]

### 新功能（支付/券闭环，2026-08-31）
- admin 面板六分类重构（概览/账号/会员与支付/通用/数据/高级）；账号卡微信扫码登录（设备码 RFC 8628 + 内嵌二维码）；会员并入设置
- 下单前试算（`POST /api/license/trial`，kaypal calculate + 券规则预估折后价，只读不核销）；购买透传券码（幂等指纹纳入券码，换券重试判冲突）
- Kaypal 订单折扣券对接（我的券列表/分享券模块 getShareLink/claimShare）；本地券体系全量下线
- 自研零依赖二维码编码器（qrcode.js，v1-v10/M 级，黄金向量锁定正确性）

### 安全加固（两轮复核 review-fix）
- 凭据文件（desktop-auth.json）与设备流文件（device-flow.json）禁符号链接：POSIX 走 fd 级 `O_NOFOLLOW`（open 阶段拒绝，无 TOCTOU 竞态窗口）；外部凭据/外部 device_code 一律 fail-closed
- 试算路径严格只读（不迁移旧明文、不收紧权限、不创建数据密钥）；`.vault-key` 降级明文写入改 wx 临时文件 + rename 原子落位
- 注入面板属性转义（escAttr）；设备码轮询纳入注入生命周期（disposer）

### 已知平台限制（Windows）
- **凭据文件的符号链接防护在 Windows 为降级实现**（lstat 预检 + 读取，存在理论上的替换竞态窗口）：Node 在 Windows 不暴露 `O_NOFOLLOW`，彻底消除需原生 `CreateFile(FILE_FLAG_OPEN_REPARSE_POINT)`，收益/成本不匹配暂不引入原生依赖。缓解：Windows 创建符号链接默认需管理员权限或开发者模式，凭据目录位于用户 profile 下。后续如引入原生模块可升级为 fd 级防护。

## [1.0.2] - 2026-08-31

### 修复（P0，云电脑真机抓到）
- **Windows 安装目录与自动更新目标不一致**：build-win.js 打 makensis 未传 `-DINSTALL_DIR_NAME`，installer.nsi 兜底 `WorkDaddy` → 实际装到 `%LOCALAPPDATA%\Programs\WorkDaddy`，而 daemon 期望/更新替换目标是 `JiuZhangAI`（daemon.js WIN_INSTALL_NAME）→ 自动更新装到空目录、用户仍跑旧目录（更新链路静默死）。修复：build-win.js 增加 `--install-dir-name`（默认 `JiuZhangAI`，与 daemon 一致）并传 define；installer.nsi 默认值同步改 `JiuZhangAI`
- **升级场景旧 Run 键残留**：旧版 `WorkDaddyWatchdog` Run 键不清理 → 与 `JiuZhangAIWatchdog` 双 watchdog 开机竞争。修复：安装段 DeleteRegValue 旧键

### 发版
- 双平台 1.0.2 重发：OSS updates/1.0.2（latest 切流）+ GitHub Release v1.0.2 + verify-release 全绿

## [1.0.1] - 2026-08-31

### 修复（UI）
- 注入面板品牌行截断：`.wbs-brand-line` 原 max-width:230px + ellipsis，品牌名「JIUZHANG AI 管家 —— WorkBuddy 本地管家」被截成省略号 → 去掉截断限制，改 line-height:1.4 + overflow-wrap:break-word，完整显示（空间不足时自然换行）
- 同步：本机 app 内置脚本 + dist/win-staging；daemon 注入实时读文件，刷新页面即生效

### 发版
- 双平台 1.0.1 重发：OSS updates/1.0.1（latest 切流）+ GitHub Release v1.0.1 + verify-release 19/19

## [1.0.0] - 2026-08-31

### 品牌正式版
- **改名**：WorkDaddy / 九章AI管家 → **JIUZHANG AI 管家**（用户可见层全量：app 名、安装包、面板、文档；内部标识 → ASCII JiuZhangAI 防 NSIS 非 ASCII 坑）
- 双通道发布：OSS updates/1.0.0（latest 已切流）+ GitHub Release v1.0.0（双平台签名验签 PASS）+ verify-release 19/19

## [0.3.1] - 2026-08-30

### 修复（第二/三/四轮复核打回项）
- **daemon 启动崩溃**：`isAllowedApiOrigin` TDZ（声明在使用点之后）+ 未定义变量 → 真实启动 ReferenceError。已修并落「真实启动冒烟」铁律（独立数据目录启动 + API 探活）。
- 凭据明文清理闭环：sweep 正则改后缀格式（`.plain-bak-<ts>`），`sweepAllPlainBackups` 接入 daemon 启动；账号/凭据明文迁移失败 fail-closed。
- macOS Keychain 写入回归：`accountDataKey` 新建/迁移重新接入 `encKeychainSetKey`；`.vault-key` 明文迁移补 Keychain 分支。
- Windows：账号密钥接 DPAPI（CurrentUser Protect）；备份清单相对路径统一 POSIX（`app\sessions.json` 嵌套文件恢复回归修复）；`writeAccountFile` 真原子写。
- 账号导入密码必填（前后端一致；删除 `workdaddy` 默认密码回退，v1 导入需显式密码）。
- JZVAULT 导入空密码 fail-closed（undefined 不再被 KDF 当 `"undefined"` 字面量）。
- 符号链接：blob 读取 `readBlobStrict`（lstat 拒链接，verify/export/preview 全覆盖）；restore 目标父目录链逐段校验；accounts 目录物理校验；listBackups 跳过链接 manifest。
- 导入失败（尺寸/hash 校验、写入异常）统一清理 blobs；缺失 `manifest.items` 的损坏包拒绝导入。
- 预览消费时机：restore/handoff-apply 锁忙不再提前消费 previewId（重试不再 PREVIEW_INVALID）。
- `workbuddyDir()` 按 profile 返回（workbuddy-ai 不再读写国内版 `~/.workbuddy`）；handoff 预览与实际应用目标一致。
- 更新 apply 失败 422；无账号导出 404；导入异常 400/500 分流；会话恢复返回实际行数。
- `safeRel` 拒绝反斜杠 + `../`（读取侧统一 `safeBlobPath`）。
- OSS 客户端 multipart 签名修复（uploads 无值 subResource / Date 一致性 / POST Content-Type）+ apply-update.sh stop_daemons set -u/ERR trap 修复。

### 测试
- 基线 **288/288** + gate 6/6 + 真实启动冒烟（独立数据目录）通过；真实 OSS 26.7MB 3 分片上传 + 回读 SHA256 一致。

## [0.3.0] - 2026-08-29

### 安全（P0/P1 修复，全量代码复核）
- **移除本地铸券 API** `/api/coupon/create`——本地不再能自铸权益；优惠券只能由服务端签名/订单结果驱动（kaypal 券走 `/api/coupon/kaypal/redeem`）。
- **entitlement 缓存加 HMAC 防伪**：`license/entitlement.json` 写入带平台密钥派生的 MAC，读取校验，伪造/篡改文件视为无缓存（fail-closed）。
- **会话/账号删除纳入高风险确认**：`/api/sessions/delete`、`/api/delete` 要求一次性 confirmToken（/api/auth/confirm 签发），响应统一 envelope 格式。
- **会话 ID / backupId / previewId 严格校验**：统一字符集白名单 + 根目录约束，杜绝路径穿越/越界删除/越界读文件。
- **OIDC / desktop-auth token 平台密钥加密**：access/refresh token 不再 0600 明文落盘，改 Keychain/DPAPI/0600 文件三级密钥 AES-256-GCM 加密；旧明文读取时自动迁移。
- **授权缓存反伪造测试**：手改 entitlement.json（伪 Pro/伪余额）不被信任。
- `atomicWriteJSON`/`atomicWriteJSONPrivate` 失败时清理 tmp（磁盘满/断电不留残留）。

### 正确性与可靠性（P1）
- 购买幂等写盘失败不再 `.catch()` 同步函数（曾致"支付成功却报 502 假失败"）。
- 优惠券兑换改为原子事务：先算后写、失败回滚，杜绝"中途失败留部分状态、重试重复发权益"。
- Kaypal 券兑换强制幂等键（8-128 位）。
- 清理接口失败透传：单项失败计入 `failed`，全部失败返回 422（不再"未执行却 200 ok:true"）。
- readBody / 导入上传流加 idle timeout（30s 无数据断连，防慢连接长期占用）。
- OSS 客户端实现 Multipart Upload：10MB 分片 × 并发 3 + 指数退避重试 + 请求超时；发版大文件（DMG/exe）自动走分片。
- Windows ZIP 更新分支补安装后校验 + 失败回滚 + 非零退出码（原直接删 .old 失败不可恢复）。

### 工程（P2）
- `package-lock.json` 版本与 `package.json` 同步 0.3.0。
- `verify-live-win.js` 兼容新 ASCII 安装目录 `Programs\JiuZhangAI`。
- asset checksum 覆盖 permission/risk/coverage/importance；列表读取排除符号链接。
- `null` Origin 默认拒绝（file:// / 跨站 iframe 不得驱动本地 API）。
- 测试基线提升至 288/288（2026-08-30）；文档数字统一（OVERVIEW/docs/README）。

### 发版
- macOS DMG + Windows NSIS 双平台签名产物；OSS updates/ + GitHub Release 双通道（见 docs 发版记录 §36）。

## [0.2.x] - 2026-08-26 ~ 08-28

- v0.2.1 签名发布；OSS latest + GitHub Releases 双通道。
- 九轮复查修复：CORS 预检前移、保险箱敏感白名单、购买幂等+pending 窗口、隐私盾（本地掩码+点击/Enter 重放标记）、health-check root 修复、staging 配额预留、manifest 写失败清理、幂等持久化、符号链接防护、诊断 previewId 闭环、auto-backup 动态 reload、人脸识别 sameComposerZone 排除、扫描并发队列等（测试 125→191）。
- Windows 中文安装路径 NSIS 静默失败修复（INSTALL_DIR_NAME=JIUZHANG AI 管家 ASCII）。
- apply 复用残留解包修复（resolveUnpackTarget 三态）。
- oss-client 中文 key URL 编码修复。
- 能力提炼 V0.2/V1.0/V1.1 模块落地：handoff / operation-store / watchdog / memory-store / asset-store / skill-policy / asset-extractor / usage-store / model-fit。

## [0.1.x] - 2026-08-24 ~ 08-25

- 上游 JIUZHANG AI 管家 二开基线建立：安全改造（token 鉴权、AES-256-GCM 备份、更新验签、回收站语义）、本地管理页、健康检查/修复骨架、Kaypal 会员接入。
- 双仓库文档迁移与实现核对（8 份设计稿）。
