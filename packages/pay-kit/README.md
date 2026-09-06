# pay-kit —— 微信扫码支付架构复用包

jz-ai-guard 微信直连商户支付全链的复用分发（2026-09-01 抽取，生产实锤：304 用例 + ¥0.01 真实付款闭环）。

## 三层结构与复用度

| 层 | 目录 | 内容 | 复用度 |
|---|---|---|---|
| 应用层（客户端） | `pay-core/` | kaypal-pay.js（exchange 会话 + 幂等下单 + 查单轮询）、license-routes.reference.js（幂等购买路由） | ~90%，改配置即用 |
| 平台层（服务端） | `pay-server/` | exchange 路由模板、支付回调订阅同步模板、档位映射模板 | 接 kaypal 底座零代码；独立系统抄模板 |
| 交互层（UI） | `pay-ui/` | 支付页三态流程（出码→3s 轮询→激活确认） | 参考实现，按宿主替换工具函数 |

## 快速接入（kaypal 平台上的新应用，约一天）

1. **kaypal 侧**：subscriptionPlanProduct 配套餐 → `pay-server/entitlement-mapping.template.ts` 加一行套餐映射
2. **daemon 侧**：拷 `pay-core/kaypal-pay.js`（改 6 配置点，见下表）+ 按 `license-routes.reference.js` 接 purchase/pay/query/order-status 四条路由（幂等语义照抄，**不要简化**——409/PENDING 窗口/并发锁每一个都是打回过的坑）
3. **面板侧**：按 `pay-ui/payment-flow.js` 接支付页（轮询纪律：进新流程/取消/成功/关闭一律先停旧轮询）
4. **验收**：按文末 E2E 清单跑，最后一单 ¥0.01 真实扫码付款闭环

## 必改的 6 个配置点（耦合点，搬过去不改必炸）

| # | 耦合点 | 位置 |
|---|---|---|
| 1 | Cookie 名 `kaypal_auth=` | kaypal-pay.js 会话链 + 服务端 exchange 返回的 token_type 对齐 |
| 2 | 端点路径 `/api/desktop-auth/exchange`、`/api/pricing/*`、`/api/payment/*` | kaypal-pay.js / api.js 路由 |
| 3 | 套餐 planId + 档位映射 | entitlement-mapping.template.ts PLAN_CODE_TO_TIER |
| 4 | 商户号/APIv3 密钥/证书 | 服务端 env——**每系统独立进件，严禁共用** |
| 5 | 幂等窗口 10min（JZ_PURCHASE_PENDING_MS）/ JWT 15min（EXCHANGE_TTL_SECONDS） | api.js / exchange-route.template.ts，按新系统业务调 |
| 6 | 金额单位"分" + 折后价以订阅单 price 为准（券后价，不能拿目录价兜底） | buyPlanWechat 金额链 |

## 完全独立系统（不经 kaypal）额外要自建

订单/订阅表（照 subscriptionOrder + userSubscription 全字段建模，含 billingCycle/endDate/autoRenew）→ `payment-callback-sync.template.ts`；会话签发 → `exchange-route.template.ts`；商户进件 + 服务端收微信 notify 回调（桌面端只轮询查单，**不碰回调**，这是安全设计）。

## 同步守卫（防双源漂移）

- 真源 = `scripts/jz/{kaypal-pay.js, api.js, admin-ui.js}`（daemon require + 发版打包唯一来源）
- kit 副本 = 本目录 pay-core/pay-ui 下的分发文件（锚点抽取，字节级一致）
- **改真源后必须跑 `node scripts/sync-pay-kit.js` 并一并 commit**；`test/test-pay-kit-sync.js` 会在 npm test 里校验，不同步就红

## E2E 验收清单（8 用例 + 真实付款）

1. GET /api/license/plans 拉到 kaypal 真实套餐
2. passwordLogin 桌面登录
3. GET /api/license/order/status 未登录 401 / 登录后 200
4. POST /api/license/purchase 建单（幂等键 + ¥0.01 测试套餐）
5. 同幂等键回放 → 200 同一 orderNo
6. GET /api/license/pay/query → pending（未付）
7. GET /api/qrcode → SVG 出码
8. 换幂等键回放 → 200 同一单（跨 key 成功回放）
9. **手机扫码付 ¥0.01** → pay/query=paid（含 thirdTradeNo）→ order/status=active（到期 +30/365 天）
