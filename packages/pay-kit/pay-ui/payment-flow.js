// [pay-kit 分发副本] 唯一真源: scripts/jz/admin-ui.js 912-990 行 + 1016-1042 行（锚点抽取）
// 本文件由 scripts 同步生成，请勿直接改这里——改真源后跑 node scripts/sync-pay-kit.js 重新同步。
// 支付页流程参考实现：三态（出码等待→3s 轮询→激活确认）+ 轮询纪律（进新流程/取消/成功/关闭先停旧轮询）。
// 依赖宿主页面的 api()/escapeHtml()/show()/renderLicense() 等工具函数，接入时按宿主替换。
  // ===== 微信扫码支付（Task#11 2026-09-01）=====
  // 链路：purchase(幂等) → 出码(/api/qrcode 内嵌 codeUrl) → 3s 轮询 pay/query → paid 后 order/status 确认激活。
  // 轮询纪律：进新流程/取消/成功/关闭一律先停旧轮询（同 wxPollTimer 教训）；超时 5 分钟给手动兜底按钮。
  var payPollTimer = null;
  // Codex 复核 P2 修复：查单连续失败计数（网络异常/查单 502 不再静默吞掉），达到阈值给出可见状态。
  var payPollFailCount = 0;
  function stopPayPoll() { if (payPollTimer) { clearInterval(payPollTimer); payPollTimer = null; } }
  function fmtFen(fen) { return '¥' + (Number(fen) / 100).toFixed(2); }
  function setPayState(txt, ok) {
    var s = document.getElementById('pay-state');
    if (s) { s.textContent = txt; s.style.color = ok ? 'var(--ok)' : 'var(--muted)'; }
  }
  function payConfirmActivated() {
    api('GET', '/api/license/order/status').then(function (s) {
      if (s.ok && s.data && s.data.hasSubscription && s.data.status === 'active') {
        var el = document.getElementById('out-license');
        el.innerHTML = '<div class="kv"><span>支付结果</span><b style="color:var(--ok)">支付成功 · 会员已激活</b></div>' +
          '<div class="kv"><span>套餐</span><b>' + escapeHtml(planDisplayName(s.data.planId, s.data.planId)) + '</b></div>' +
          '<div class="kv"><span>有效期至</span><b>' + escapeHtml(String(s.data.expiresAt || '-').slice(0, 10)) + '</b></div>';
        el.classList.remove('empty');
      } else {
        show('out-license', '支付成功，会员激活确认中（微信回调可能有延迟）——稍后点「查看会员状态」确认');
      }
      renderLicense();
    });
  }
  function payPollOnce(d, manual) {
    api('GET', '/api/license/pay/query?orderNo=' + encodeURIComponent(d.orderNo)).then(function (r) {
      if (!r.ok) {
        if (r.error === 'UNAUTHENTICATED') { stopPayPoll(); show('out-license', '登录已过期，请到「账号」页重新登录后再查单'); return; }
        // Codex 复核 P2 修复：查单失败（daemon 502 等）计入连续失败，不再无痕吞掉
        payPollFailCount++;
        if (payPollFailCount === 5) setPayState('查单连续失败（网络不稳），仍在重试…');
        if (payPollFailCount >= 20) { stopPayPoll(); setPayState('查单连续失败已停止轮询。若已完成支付，请点「查看会员状态」确认'); }
        return; // 网络抖动等下一轮
      }
      payPollFailCount = 0;
      if (r.data && r.data.status === 'paid') { stopPayPoll(); setPayState('支付成功，正在确认会员激活…', true); payConfirmActivated(); return; }
      if (r.data && r.data.status === 'closed') { stopPayPoll(); show('out-license', '订单已关闭，如需购买请重新发起'); return; }
      if (manual) setPayState('还未查到支付结果（微信回调可能有延迟），继续等待…');
    }).catch(function () {
      // Codex 复核 P2 修复：请求本身异常（网络断等）同样计入连续失败，不再静默吞掉
      payPollFailCount++;
      if (payPollFailCount === 5) setPayState('查单连续失败（网络不稳），仍在重试…');
      if (payPollFailCount >= 20) { stopPayPoll(); setPayState('查单连续失败已停止轮询。若已完成支付，请点「查看会员状态」确认'); }
    });
  }
  function startPayPoll(d) {
    stopPayPoll();
    payPollFailCount = 0;
    var deadline = Date.now() + 5 * 60 * 1000;
    payPollTimer = setInterval(function () {
      if (Date.now() > deadline) {
        stopPayPoll();
        setPayState('等待支付超时（5 分钟）。若已完成支付，请点「查看会员状态」确认激活结果');
        return;
      }
      payPollOnce(d, false);
    }, 3000);
  }
  function renderPayPending(d) {
    var el = document.getElementById('out-license');
    el.innerHTML =
      '<div class="kv"><span>微信扫码支付</span><b>' + escapeHtml(fmtFen(d.amountFen)) + '</b></div>' +
      '<div class="kv"><span>订单号</span><b>' + escapeHtml(String(d.orderNo)) + '</b></div>' +
      '<div class="qrbox" id="qr-pay"><span class="empty">正在生成支付二维码…</span></div>' +
      '<div class="row"><span id="pay-state" style="font-size:12px;color:var(--muted)">等待扫码支付…（请勿重复下单）</span>' +
      '<button class="ghost sm" id="btn-pay-manual">我已完成支付</button>' +
      '<button class="ghost sm" id="btn-pay-cancel">取消</button></div>';
    el.classList.remove('empty');
    api('GET', '/api/qrcode?text=' + encodeURIComponent(d.codeUrl)).then(function (q) {
      var box = document.getElementById('qr-pay');
      if (box && q.ok && q.data && q.data.svg) box.innerHTML = q.data.svg;
      else if (box) box.innerHTML = '<span class="empty">二维码生成失败，可在手机微信打开支付链接完成支付</span>';
    });
    document.getElementById('btn-pay-cancel').onclick = function () { stopPayPoll(); renderLicense(); };
    document.getElementById('btn-pay-manual').onclick = function () { payPollOnce(d, true); };
  }

  // --- 购买按钮接线（loadPlans 内） ---
      row.querySelectorAll('[data-buy]').forEach(function (btn) {
        btn.onclick = function () {
          if (btn.disabled) return; // 在途禁用（复查 P1：防双击重复下单）
          var planId = btn.getAttribute('data-buy');
          // 复查 P1：购买强制幂等键 + 按钮在途禁用，支付超时重试防重复下单
          btn.disabled = true;
          stopPayPoll(); // 新购买先停旧轮询（防双轮询状态错乱）
          var couponCode = (document.getElementById('coupon-code') || {}).value || '';
          var body = { planId: planId, paymentMethod: 'wechat', idempotencyKey: newIdemKey() };
          if (couponCode) body.couponCode = couponCode;
          api('POST', '/api/license/purchase', body).then(function (rr) {
            if (rr.ok && rr.data && rr.data.orderNo) {
              renderPayPending(rr.data);
              startPayPoll(rr.data);
            } else if (rr.error === 'UNAUTHENTICATED') {
              show('out-license', '请先在「账号」页完成登录，再购买会员');
            } else if (rr.error === 'PURCHASE_PENDING' || rr.error === 'OPERATION_RUNNING') {
              show('out-license', (rr.data && rr.data.reason) || '上一笔同套餐购买请求处理中（防重复下单保护），请稍后点「查看会员状态」确认');
            } else if (rr.error === 'PAYMENT_METHOD_UNAVAILABLE') {
              show('out-license', '当前仅支持微信扫码支付（支付宝当面付签约中）');
            } else {
              show('out-license', rr);
            }
          }).finally(function () { btn.disabled = false; });
        };
      });
    }).catch(function () {
