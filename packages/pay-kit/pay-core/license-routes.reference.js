// [pay-kit 分发副本] 唯一真源: scripts/jz/api.js 1399-1711 行（锚点抽取）
// 本文件由 scripts 同步生成，请勿直接改这里——改真源后跑 node scripts/sync-pay-kit.js 重新同步。
// 幂等购买路由参考实现：POST /api/license/purchase 全幂等语义（同键回放/指纹冲突/PENDING 窗口/并发锁/507 释放锁）。
// GET /api/license/pay/query + /api/license/order/status 为配套查单/激活确认端点。
      if (method === 'GET' && p === '/api/license/order/status') {
        // 订阅激活状态确认（支付后用）。Task#11（2026-09-01）改走 kaypal-pay.checkSubscription：
        // exchange JWT（Cookie 会话）查 GET /api/pricing/subscription/status?type=individual——
        // 2026-09-01 实测 200（旧 Bearer kda 路径在 subscribe 类路由会卡 route 层会话校验，统一收敛到 Cookie 链）。
        // 返回 { hasSubscription, status: active|none, expiresAt, planId }。type= 参数保留兼容但忽略（桌面端仅 individual）。
        const r = await kaypalPay.checkSubscription({ root: dataDir, _httpsJson: kHttp });
        if (!r.ok) {
          const unauth = r.needLogin || r.error === 'NOT_LOGGED_IN' || r.error === 'SESSION_EXPIRED';
          return send(res, unauth ? 401 : 502, envelope(false, { detail: r.detail || r.error },
            unauth ? 'UNAUTHENTICATED' : 'ORDER_STATUS_UNAVAILABLE', requestId));
        }
        return send(res, 200, envelope(true, {
          hasSubscription: r.hasSubscription,
          status: r.status,
          expiresAt: r.expiresAt,
          planId: r.planId,
        }, null, requestId));
      }
      if (method === 'POST' && p === '/api/license/purchase') {
        // 会员购买（Task#11 2026-09-01）：微信 native 扫码全链（kaypal-pay.buyPlanWechat：
        // exchange JWT Cookie 会话 → subscribe 订阅单 → payment/create 微信单 → codeUrl）。
        // 返回 data = {orderId, orderNo, codeUrl, amountFen, priceYuan, status:'pending'}，
        // 支付状态由 GET /api/license/pay/query?orderNo= 轮询，激活由 /api/license/order/status 确认。
        // 复查 P1（2026-08-29）：强制订单幂等键 + 持久化 —— 支付超时重试/重复点击不重复创建订单。
        if (!IDEMPOTENCY_KEY_RE.test(String(body.idempotencyKey || ''))) {
          return send(res, 400, envelope(false, { reason: '必须提供 8-128 位订单幂等键（字母/数字/_/-）' }, 'INVALID_REQUEST', requestId));
        }
        const planId = String(body.planId || '');
        // Task#11（2026-09-01）：微信 native 扫码支付为唯一在途支付通道
        //（支付宝当面付未签约——收了 alipay 参数也不能静默走微信，直接 400 拒绝）。
        const paymentMethod = 'wechat';
        if (body.paymentMethod && body.paymentMethod !== 'wechat') {
          return send(res, 400, envelope(false, { reason: '当前仅支持微信扫码支付（支付宝当面付签约中）' }, 'PAYMENT_METHOD_UNAVAILABLE', requestId));
        }
        if (!planId) return send(res, 400, envelope(false, null, 'INVALID_REQUEST', requestId));
        const auth = loadDesktopAuth(dataDir);
        if (!auth || !auth.accessToken) {
          return send(res, 401, envelope(false, null, 'UNAUTHENTICATED', requestId));
        }
        // 幂等登记（持久化 purchase-idempotency.json）：同键同参 → 返回首次结果；同键不同参 → 冲突
        // Codex 复核 P2 修复：券码规范化补 trim（与 kaypal-pay subscribePlan 的 trim 对齐，指纹才与实际核销一致）。
        const couponCodeNorm = body.couponCode ? String(body.couponCode).trim() : '';
        const userKey = `${(auth.user && (auth.user.id || auth.user.userId)) || 'local'}:${String(body.idempotencyKey)}`;
        // Codex 复核 P1 修复：bizKey 必须含券码——原 bizKey 只到 planId 粒度，"同套餐换券换幂等键重试"
        // 会命中旧券成功记录直接回放旧订单（新券被静默丢弃）。券码进 bizKey 后，换券 = 换保护窗口，
        // 各券独立防重复下单；同键不同参仍被指纹校验拦成 IDEMPOTENCY_CONFLICT。
        const bizKey = `${(auth.user && (auth.user.id || auth.user.userId)) || 'local'}:${planId}:${paymentMethod}:${couponCodeNorm}`;
        const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ planId, paymentMethod, couponCode: couponCodeNorm })).digest('hex');
        const idemPath = path.join(dataDir, 'license', 'purchase-idempotency.json');
        const idemStore = readJSON(idemPath) || { records: [] };
        const prev = idemStore.records.find((r) => r.storeKey === userKey);
        if (prev) {
          if (prev.fingerprint !== fingerprint) {
            return send(res, 409, envelope(false, { reason: '同幂等键但购买参数不同' }, 'IDEMPOTENCY_CONFLICT', requestId));
          }
          // 复查 P1（第五轮）：pending 记录无 body/status，读 prev.body.ok 会 500 → 单独处理
          if (prev.result === 'pending') {
            return send(res, 409, envelope(false, { reason: '该购买请求结果未确认（在途或超时），请稍后在会员状态页确认' }, 'PURCHASE_PENDING', requestId));
          }
          if (prev.result === 'success') {
            // 回放数据结构与首次成功一致（data = 订单对象，不多嵌一层）
            return send(res, prev.status || 200, envelope(true, prev.body ? prev.body.data : null, null, requestId));
          }
          // 显式失败记录：清除后走新流程（可重试）
          idemStore.records = idemStore.records.filter((x) => x !== prev);
        }
        // 不确定结果窗口（复查 P1 第四轮）：同一 user+plan+支付方式 在窗口内已有未决请求
        //（在途或超时未确认）→ 拒绝新订单，提示查会员状态，杜绝"响应丢失后换 key 重试"重复下单。
        // 确定性失败不留痕（可立即重试）；成功记录窗口内直接回放。
        // R7-1（复核 P1）：10 分钟 TTL **只适用于普通在途**。"渠道结果未知"锁
        //（unknownOutcome，微信侧可能已建单但响应丢失）没有确认期限——TTL 一到换键重试
        // 就会重新 subscribe（新 orderId → kaypal 兜底幂等键也变）建出第二张可扫的码。
        // 正确策略：持续锁定，直到查单/锁单重放证实渠道单 CLOSED/FAILED（放行重建）
        // 或已收款（收敛为成功）——绝不能仅靠 TTL 自动放行。
        const pendingMs = Number(process.env.JZ_PURCHASE_PENDING_MS) || 10 * 60 * 1000;
        const bizPrev = idemStore.records.find(
          (r) => r.bizKey === bizKey && (r.unknownOutcome || Date.now() - new Date(r.at).getTime() < pendingMs)
        );
        if (bizPrev) {
          if (bizPrev.result === 'success') {
            // 复查 P1（第五轮）：回放结构与首次成功一致
            return send(res, bizPrev.status || 200, envelope(true, bizPrev.body ? bizPrev.body.data : null, null, requestId));
          }
          // R7-1：结果未知锁 → 先"锁单重放"探测真实结果。重放对**同一笔订阅单**调
          // payment/create（kaypal 兜底键必命中旧 PaymentOrder）：有凭证原样重放、
          // PENDING 无凭证同单号重挂、渠道确认终结才让位重建——不存在"放行第二张码"。
          if (bizPrev.result === 'pending' && bizPrev.unknownOutcome && bizPrev.orderId && bizPrev.amountFen) {
            // 探测也要过在途锁：并发双击同时探测时，"渠道终结→让位→重建"窗口内
            // 双方可能各拿一个结果互相覆盖（kaypal 兜底幂等是最后防线，本地锁先挡住）。
            if (purchaseInFlight.has(bizKey)) {
              return send(res, 409, envelope(false, { by: 'purchase_in_flight' }, 'OPERATION_RUNNING', requestId));
            }
            purchaseInFlight.add(bizKey);
            let re = null;
            let probeErr = null;
            try {
              re = await kaypalPay.reattachWechatPayment({
                orderId: bizPrev.orderId,
                amountFen: bizPrev.amountFen,
                subject: 'JIUZHANG AI 管家会员',
                root: dataDir,
                _httpsJson: kHttp,
              });
            } catch (e) {
              probeErr = e;
            } finally {
              purchaseInFlight.delete(bizKey);
            }
            if (probeErr || !re) {
              // 探测自身异常 = 依然无法证实，保守锁继续
              return send(res, 409, envelope(false, {
                reason: '上一笔购买结果未确认，自动查单暂不可用；为防重复扣款已持续锁定，请稍后重试本操作',
                since: bizPrev.at,
              }, 'PURCHASE_PENDING', requestId));
            }
            if (re.ok) {
              const data = {
                orderId: bizPrev.orderId,
                orderNo: re.orderNo,
                codeUrl: re.codeUrl,
                amountFen: re.amountFen,
                priceYuan: bizPrev.priceYuan ?? (re.amountFen / 100),
                paymentMethod,
                status: 'pending',
              };
              bizPrev.result = 'success';
              bizPrev.unknownOutcome = false;
              bizPrev.status = 200;
              bizPrev.body = { ok: true, data };
              bizPrev.storeKey = userKey;
              bizPrev.fingerprint = fingerprint;
              try { atomicWriteJSON(idemPath, idemStore); } catch (e) { /* 写盘失败不翻支付结果，仅降级日志 */ }
              return send(res, 200, envelope(true, data, null, requestId));
            }
            if (re.error === 'PAY_UNAVAILABLE') {
              // 仍无法证实（查单/重放又超时，或渠道明确说结果未知）→ 锁继续，明确不承诺自动放行
              return send(res, 409, envelope(false, {
                reason: '上一笔购买结果未确认，已持续锁定至渠道查单证实（不会自动放行以免重复扣款）；可稍后重试本操作自动查单',
                orderNo: re.orderNo || bizPrev.orderNo || null,
                since: bizPrev.at,
              }, 'PURCHASE_PENDING', requestId));
            }
            if (re.error === 'SESSION_EXPIRED' || re.error === 'NOT_LOGGED_IN') {
              return send(res, 401, envelope(false, { detail: '会话失效，请重新登录' }, 'UNAUTHENTICATED', requestId));
            }
            // 确定性失败（渠道单确认不存在/被拒/已终结后重下失败）→ 解除未知锁，放行走正常新购
            idemStore.records = idemStore.records.filter((x) => x !== bizPrev);
            try { atomicWriteJSON(idemPath, idemStore); } catch (e) { /* 清锁写盘失败：下次仍会重试探测，保守可接受 */ }
          } else if (bizPrev.result === 'pending') {
            return send(res, 409, envelope(false, {
              reason: bizPrev.unknownOutcome
                ? '上一笔同套餐购买结果未确认，为防重复下单已拦截；本次未能自动查单（缺少单号），请到会员状态页确认'
                : '上一笔同套餐购买请求结果未确认（在途或超时），为防重复下单已拦截；请稍后在会员状态页确认，10 分钟后可重试',
              since: bizPrev.at,
            }, 'PURCHASE_PENDING', requestId));
          } else {
            return send(res, 409, envelope(false, {
              reason: '上一笔同套餐购买请求结果未确认（在途或超时），为防重复下单已拦截；请稍后在会员状态页确认，10 分钟后可重试',
              since: bizPrev.at,
            }, 'PURCHASE_PENDING', requestId));
          }
        }
        // 在途并发锁：同 user+plan+支付方式 同一时刻最多一个订阅请求进 kaypal
        if (purchaseInFlight.has(bizKey)) {
          return send(res, 409, envelope(false, { by: 'purchase_in_flight' }, 'OPERATION_RUNNING', requestId));
        }
        purchaseInFlight.add(bizKey);
        // 请求发出前先落 pending 痕迹（复查 P1：超时/响应丢失后，同 bizKey 的任何重试都会被窗口拦截）。
        // 复查 P1（第五轮）：写盘失败必须释放并发锁并返回结构化错误，绝不能锁死套餐。
        try {
          idemStore.records.push({
            storeKey: userKey,
            bizKey,
            fingerprint,
            result: 'pending',
            at: new Date().toISOString(),
          });
          if (idemStore.records.length > 200) idemStore.records = idemStore.records.slice(-200);
          atomicWriteJSON(idemPath, idemStore);
        } catch (e) {
          purchaseInFlight.delete(bizKey);
          return send(res, 507, envelope(false, { detail: `幂等记录写盘失败：${e.message}` }, 'IDEMPOTENCY_PERSIST_FAILED', requestId));
        }
        try {
          // Task#11（2026-09-01）：微信 native 全链——subscribe(订阅单) → payment/create(微信单) → codeUrl。
          // 幂等语义升级：业务成功 = 拿到微信支付单（待扫码），不是支付完成；支付状态由 /api/license/pay/query 轮询。
          // buyPlanWechat 内部 fail-closed 全捕获（不抛错），超时/网络失败同样返回 ok:false。
          const r = await kaypalPay.buyPlanWechat({ planId, couponCode: couponCodeNorm || undefined, subject: 'JIUZHANG AI 管家会员', root: dataDir, _httpsJson: kHttp });
          if (r.ok) {
            const data = {
              orderId: r.orderId,
              orderNo: r.orderNo,
              codeUrl: r.codeUrl,
              amountFen: r.amountFen,
              priceYuan: r.priceYuan,
              paymentMethod,
              status: 'pending',
            };
            // pending → success（持久化，窗口内同套餐回放；回放 data 与首次一致 = 同一微信支付单）
            const rec = idemStore.records.find((x) => x.storeKey === userKey && x.bizKey === bizKey && x.result === 'pending');
            if (rec) { rec.result = 'success'; rec.status = 200; rec.body = { ok: true, data }; }
            else { idemStore.records.push({ storeKey: userKey, bizKey, fingerprint, result: 'success', status: 200, body: { ok: true, data }, at: new Date().toISOString() }); }
            if (idemStore.records.length > 200) idemStore.records = idemStore.records.slice(-200);
            // 2026-08-29 复核 P1：reportError 是同步函数（返回对象，无 .catch），必须 try/catch 包裹，
            // 否则"支付已成功但幂等写盘失败"时抛 TypeError 被外层 catch 吞成 502 SUBSCRIPTION_UNAVAILABLE（支付假失败）。
            try {
              atomicWriteJSON(idemPath, idemStore);
            } catch (e) {
              try { reportError({ requestId, url: p, status: 200, message: `purchase success 记录写盘失败: ${e.message}` }); }
              catch (reportErr) { console.error(`[jz-api] purchase 上报失败: ${reportErr && reportErr.message}`); }
            }
            return send(res, 200, envelope(true, data, null, requestId));
          }
          // Codex 复核 P1 修复：PAY_UNAVAILABLE（超时/网络异常）= 结果不确定——远端可能已建单。
          // 原实现把所有 ok:false 都当确定性失败清除 pending 痕迹，"远端已建单 + 本地超时"后
          // 换幂等键重试会重复下单。不确定失败必须保留 pending。
          // R7-1（复核 P1）：r.unknownOutcome（微信建单结果未知）额外持久化 orderId/amountFen
          // 并打上 unknownOutcome 标记——该锁**不过 TTL**，换键重试会触发锁单重放探测
          //（对同一笔订阅单重放 payment/create，绝不换单），直到渠道证实终结或收款。
          if (r.error === 'PAY_UNAVAILABLE') {
            if (r.unknownOutcome) {
              const lock = idemStore.records.find((x) => x.storeKey === userKey && x.bizKey === bizKey && x.result === 'pending');
              if (lock) {
                lock.unknownOutcome = true;
                lock.orderId = r.orderId || null;
                lock.orderNo = r.orderNo || null;
                lock.amountFen = r.amountFen || null;
              }
              try { atomicWriteJSON(idemPath, idemStore); } catch (e) { /* 锁字段写盘失败：内存 pending 仍在，进程内保护不丢 */ }
            }
            // 复核（微信专项 P1）：带上 kaypal 回传的 orderNo——UI 可以拿它直接查单确认真实结果。
            return send(res, 502, envelope(false, {
              detail: r.unknownOutcome
                ? '购买请求结果未确认（微信侧可能已建单），系统已锁定该笔购买直至查单证实，重试将自动查单'
                : '购买请求结果未确认（网络超时），已进入防重复下单保护窗口',
              orderNo: r.orderNo || null,
              orderId: r.orderId || null,
              locked: !!r.unknownOutcome,
            }, 'SUBSCRIPTION_UNAVAILABLE', requestId));
          }
          // 确定性失败：移除 pending 痕迹（可立即重试）
          idemStore.records = idemStore.records.filter((x) => !(x.storeKey === userKey && x.bizKey === bizKey && x.result === 'pending'));
          try {
            atomicWriteJSON(idemPath, idemStore);
          } catch (e) {
            try { reportError({ requestId, url: p, status: 502, message: `purchase 失败记录清理写盘失败: ${e.message}` }); }
            catch (reportErr) { console.error(`[jz-api] purchase 上报失败: ${reportErr && reportErr.message}`); }
          }
          const unauth = r.needLogin || r.error === 'NOT_LOGGED_IN' || r.error === 'SESSION_EXPIRED';
          return send(
            res,
            unauth ? 401 : 502,
            envelope(
              false,
              { detail: r.detail || r.error || '支付单创建失败' },
              unauth ? 'UNAUTHENTICATED' : (r.error === 'SUBSCRIBE_FAILED' || r.error === 'CREATE_PAYMENT_FAILED' ? 'SUBSCRIPTION_FAILED' : 'SUBSCRIPTION_UNAVAILABLE'),
              requestId,
            ),
          );
        } catch (e) {
          // 超时/网络异常 = 结果不确定：保留 pending 痕迹，窗口内同套餐重试一律 409 PURCHASE_PENDING
          return send(res, 502, envelope(false, {
            detail: '购买请求结果未确认（网络超时），已进入防重复下单保护窗口',
          }, 'SUBSCRIPTION_UNAVAILABLE', requestId));
        } finally {
          purchaseInFlight.delete(bizKey);
        }
      }
      if (method === 'GET' && p === '/api/license/pay/query') {
        // 微信支付单状态单次查询（Task#11 2026-09-01，UI 3s 自驱轮询）：
        // 走 kaypal-pay.queryWechatPayment（Cookie 会话，kaypal /api/payment/query 实测必须带 Cookie）。
        // 返回 { status: paid|pending|closed, thirdTradeNo, payerId }；订单不可见视同 pending（继续轮询）。
        const orderNo = String(u.searchParams.get('orderNo') || '').trim();
        if (!orderNo || orderNo.length > 64) return send(res, 400, envelope(false, null, 'INVALID_REQUEST', requestId));
        const r = await kaypalPay.queryWechatPayment({ orderNo, root: dataDir, _httpsJson: kHttp });
        if (!r.ok) {
          const status = r.needLogin || r.error === 'NOT_LOGGED_IN' ? 401 : 502;
          return send(res, status, envelope(false, { detail: r.detail || r.error }, r.error || 'PAY_QUERY_FAILED', requestId));
        }
        return send(res, 200, envelope(true, { orderNo, status: r.status, thirdTradeNo: r.thirdTradeNo, payerId: r.payerId }, null, requestId));
      }
      if (method === 'GET' && p === '/api/license/coupon/share') {
        // 分享券（Codex 复核第二轮功能缺口闭环）：查/建我的分享链接 → kaypal referral/coupon（POST，getOrCreate）。
        // 鉴权：desktop-auth kda Bearer（kaypal-coupon 内部 currentAccessToken），未登录 401 fail-closed。
        const r = await getShareLink({ root: dataDir, _httpsJson: kHttp });
        if (!r.ok) {
          const status = r.error === 'UNAUTHENTICATED' ? 401 : 502;
          return send(res, status, envelope(false, { detail: r.detail || r.error }, r.error, requestId));
        }
        return send(res, 200, envelope(true, { share: r.share }, null, requestId));
      }
      if (method === 'GET' && p === '/api/license/coupon/invite-count') {
        // 邀请计数（推荐人奖励·算力券先计数）：转发 kaypal referral/mine。
        // 未登录 401 fail-closed；失败给 502，不放假计数。
        const r = await getInviteCount({ root: dataDir, _httpsJson: kHttp });
        if (!r.ok) {
          const status = r.error === 'UNAUTHENTICATED' ? 401 : 502;
          return send(res, status, envelope(false, { detail: r.detail || r.error }, r.error, requestId));
        }
        return send(res, 200, envelope(true, { count: r.count, referrals: r.referrals }, null, requestId));
      }
      if (method === 'POST' && p === '/api/license/coupon/claim') {
        // 分享券：凭分享码领券。shareCode 必填（1-64 位）；幂等键可选透传（Idempotency-Key 头防重试重复领）。
        const shareCode = String((body && body.shareCode) || '').trim();
        if (!shareCode || shareCode.length > 64) return send(res, 400, envelope(false, null, 'INVALID_REQUEST', requestId));
        const idempotencyKey = body && body.idempotencyKey ? String(body.idempotencyKey).slice(0, 128) : undefined;
        const r = await claimShare({ shareCode, idempotencyKey, root: dataDir, _httpsJson: kHttp });
        if (!r.ok) {
          const status = r.error === 'UNAUTHENTICATED' ? 401 : r.error === 'INVALID_REQUEST' ? 400 : 502;
          return send(res, status, envelope(false, { detail: r.detail || r.error }, r.error, requestId));
        }
        return send(res, 200, envelope(true, r.data || { claimed: true }, null, requestId));
      }
