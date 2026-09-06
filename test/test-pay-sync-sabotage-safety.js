'use strict';
// A0 五轮 P2-1 / P2-2 / P2-3 + 六轮 P2-1 / P2-2 的源码契约断言。
//
// 这些都是「反向验证闸门自身」的缺陷，而闸门只能在真机跑（要重启 daemon、改源码、驱动 CDP），
// 进不了 npm test。所以把实现结构钉死在这里——谁把 fail() 改回 process.exit、
// 谁删掉信号处理器、谁把备份改回 pid 命名、谁去掉场景依赖表、谁让还原失败后照写证据，CI 立刻红。
//
// 行为级验证仍由 `npm run test:e2e-paysync:sabotage`（真机）与
// `JZ_SIMULATE_FAILURE=1`（异常路径自检）承担。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const E2E_DIR = path.join(__dirname, '..', 'test', 'e2e');
const SABOTAGE = fs.readFileSync(path.join(E2E_DIR, 'cdp-pay-sync-sabotage.js'), 'utf8');
const LIFECYCLE = fs.readFileSync(path.join(E2E_DIR, 'cdp-pay-sync-lifecycle.js'), 'utf8');
// A0 九轮 P1：锁实现抽成独立模块（行为级竞态测试 test-sabotage-lock-race.js 要用真实锁代码）
const LOCK_LIB = fs.readFileSync(path.join(E2E_DIR, 'lib', 'sabotage-lock.js'), 'utf8');

function windowAfter(src, marker, size = 800) {
  const i = src.indexOf(marker);
  assert.notEqual(i, -1, `源码中应存在: ${marker}`);
  return src.slice(i, i + size);
}

// ===== P2-1：异常路径不得遗留破坏态源码 =====

test('P2-1 fail() 必须 throw，绝不能 process.exit（exit 会跳过 finally 还原）', () => {
  const w = windowAfter(SABOTAGE, 'function fail(msg)', 200);
  assert.ok(/throw new Error/.test(w), 'fail() 必须抛异常，由最外层统一清理');
  assert.ok(!/process\.exit/.test(w), 'fail() 里出现 process.exit 会绕过 try/finally，把 return true 破坏桩永久留在源码里');
});

test('P2-1 破坏/还原状态由模块级唯一真源追踪，finally 与信号处理器共用', () => {
  assert.ok(/let sabotaged = false;/.test(SABOTAGE), '应有模块级 sabotaged 标志（不能用局部变量，信号处理器拿不到）');
  assert.ok(/function restoreInject\(reason\)/.test(SABOTAGE), '应有唯一的还原函数');
  // marker 不能用裸露的 `} finally {`：exit 钩子也有一个 finally，会先命中
  const fin = windowAfter(SABOTAGE, '// ---- 兜底还原：任何异常路径', 400);
  assert.ok(/restoreInject\('finally'\)/.test(fin), 'finally 必须调用还原（覆盖所有异常路径）');
});

test('P2-1 注册 SIGINT / SIGTERM / SIGHUP 清理', () => {
  // 十一轮起信号处理器是异步收口（清场 → 还原 → 退出），窗口加宽
  const w = windowAfter(SABOTAGE, "for (const sig of [", 2600);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    assert.ok(w.includes(`'${sig}'`), `应注册 ${sig} 处理器`);
  }
  assert.ok(/restoreInject\(`signal:\$\{sig\}`\)/.test(w), '信号处理器必须走同一个还原函数');
});

test('P2-1 备份用固定路径，不得再带 process.pid（强杀后备份名就找不回来）', () => {
  // A0 七轮 P2-6：路径从全局 os.tmpdir() 改为项目内 .tmp-probe/（仍必须是固定路径）
  assert.ok(/const BACKUP = path\.join\(TMP_DIR, 'jz-inject\.sabotage\.backup\.js'\);/.test(SABOTAGE),
    '备份必须是固定路径，否则进程被 SIGKILL 后无法定位备份，破坏桩永久残留');
  assert.ok(!/sabotage-backup-\$\{process\.pid\}/.test(SABOTAGE), '不得再用 pid 命名备份');
});

test('P2-1 启动自检：检出残留破坏桩时自动从固定备份还原', () => {
  assert.ok(/function selfCheckLeftover\(\)/.test(SABOTAGE), '应有启动自检');
  const w = windowAfter(SABOTAGE, 'function selfCheckLeftover()', 1400);
  assert.ok(/SABOTAGE_MARK/.test(w), '自检应识别破坏桩标记');
  // 判定「除破坏桩外还有没有别的改动」必须用 git 当权威判据：
  // 破坏桩是替换函数体，剥掉标记行拼不回原文，字符串比对是错的。
  assert.ok(/git', \['diff', '--quiet', 'scripts\/inject\.js'\]/.test(w),
    '自检必须用 git diff 判定还原后是否干净');
  assert.ok(/fs\.writeFileSync\(INJECT, src\);/.test(w),
    '还原后若仍不干净，必须把现场写回去，绝不能拿旧备份盖掉用户的新改动');
  const call = windowAfter(SABOTAGE, '// ---- 安全前置 ----', 700);
  const selfIdx = call.indexOf('selfCheckLeftover()');
  const dirtyIdx = call.indexOf("fail('scripts/inject.js 有未提交改动");
  assert.ok(selfIdx !== -1 && selfIdx < dirtyIdx,
    '自检必须排在 git 干净检查之前——残留破坏桩本身就会让 diff 非空，否则永远走不到自检');
});

// ===== P2-2：三个守卫都要有证据，不能只留默认目标 =====

test('P2-2 默认遍历全部目标（JZ_SABOTAGE 缺省为 all）', () => {
  assert.ok(/const key = process\.env\.JZ_SABOTAGE \|\| 'all';/.test(SABOTAGE),
    '默认必须是 all，否则仓库只会留下单个目标的证据，与文档宣称不符');
  for (const k of ['payPurchase', 'payPoll', 'paySync']) {
    assert.ok(new RegExp(`${k}: \\{ fn: '`).test(SABOTAGE), `TARGETS 应包含 ${k}`);
  }
});

test('P2-2 证据是聚合结构：targets 数组覆盖本次所有目标', () => {
  assert.ok(/targets: keys\.map/.test(SABOTAGE), '证据应写入 targets 数组（每个目标一条 phase1 结果）');
  const w = windowAfter(SABOTAGE, '// ---- 阶段 1：逐个破坏守卫', 2400);
  assert.ok(/for \(const k of keys\)/.test(w), '应逐个目标遍历破坏 + 验证');
  assert.ok(/restoreInject\(`restore:\$\{k\}`\)/.test(w), '每个目标跑完立刻还原，避免多目标叠加成混沌态');
});

// ===== P2-3：单场景过滤不得允许空跑通过 =====

test('P2-3 E2E 场景过滤必须有依赖表，场景 4/6 需补齐前置', () => {
  assert.ok(/const DEPS = \{/.test(LIFECYCLE), '应定义场景依赖表');
  const w = windowAfter(LIFECYCLE, 'const DEPS = {', 300);
  assert.ok(/4: \[3\]/.test(w), '场景4（关面板后不刷新）依赖场景3 建立的同步链');
  assert.ok(/6: \[7\]/.test(w), '场景6（destroy 后不刷新）依赖场景7 留下的活动链');
  assert.ok(/const expand = \(list\)/.test(LIFECYCLE), '过滤时应求依赖闭包，自动补齐');
});

test('P2-3 场景 4 / 6 必须有「确实存在活动链」的前置断言', () => {
  assert.ok(/const hasActiveSyncChain = async/.test(LIFECYCLE), '应有活动链探测');
  const w = windowAfter(LIFECYCLE, 'const hasActiveSyncChain = async', 300);
  assert.ok(/refreshCount > a/.test(w), '判据应是观测窗口内 refresh 计数增长');
  const s4 = windowAfter(LIFECYCLE, '// ---- 场景4：关闭面板后停止刷新 ----', 700);
  assert.ok(/if \(!\(await hasActiveSyncChain\(\)\)\)/.test(s4), '场景4 关闭面板前必须先确认有活动链，否则「刷新数不变」是空跑通过');
  assert.ok(/前置不足/.test(s4), '前置不满足时应给出明确原因而非静默通过');
  const s6 = windowAfter(LIFECYCLE, '// ---- 场景6：destroy 后不再刷新 ----', 700);
  assert.ok(/if \(!\(await hasActiveSyncChain\(\)\)\)/.test(s6), '场景6 destroy 前必须先确认有活动链');
});

test('同步链（paySync）的验证必须挂在确定性场景 7，不能靠场景 1 撞运气', () => {
  // 同步链是「setTimeout + HTTP 回调」：stopPaySync() 会 clearTimeout，
  // 只有旧链恰好在 HTTP 在飞时回调才会续期，窗口 ≈ 几十 ms / 3s 周期 ≈ 1~3%。
  // 五轮 all 模式实测：同一份代码，场景1 有时 FAIL 有时 PASS —— 概率性检测不能当闸门。
  assert.ok(/paySync: \{ fn: 'paySyncAlive', scene: 7/.test(SABOTAGE),
    'paySync 的验证目标必须是场景 7（确定性构造在飞回调），不能是场景 1');
  // 八轮 P2-4 后场景7 体量变大（正向基线 + B 链等待 + 下界），窗口随之加宽
  const s7 = windowAfter(LIFECYCLE, '// ---- 场景7（A0 五轮）', 6800);
  assert.ok(/__e2eHoldRefresh\s*=\s*true/.test(s7), '场景7 必须挂起 A 链的 refresh，把「在飞」变成确定态');
  assert.ok(/await releaseRefresh\(\)/.test(s7), '场景7 必须在切新单之后才释放 A 的在飞响应');
  assert.ok(/delta = rAfter - rBefore/.test(s7), '判据应是释放后 refresh 增量（单链≤4，双链约6~7）');
  // 挂起失败必须判 FAIL，不能静默通过
  assert.ok(/本场景无效（不是产品缺陷）/.test(s7), '挂起不成功时应明确报「本场景无效」而非静默 PASS');
});

test('P2-3 JZ_E2E_ONLY 取值非法时应直接报错，且上界不得写死（防新增场景漏登记）', () => {
  const w = windowAfter(LIFECYCLE, 'const rawOnly = process.env.JZ_E2E_ONLY', 900);
  assert.ok(/throw new Error/.test(w), 'JZ_E2E_ONLY 传入非法值应报错，不能静默变成「全不过滤」或「全过滤」');
  assert.ok(/const SCENE_IDS = \[/.test(LIFECYCLE), '应有场景号白名单');
  assert.ok(/!SCENE_IDS\.includes\(n\)/.test(w), '校验必须查白名单，不得写死 n > 6 这类上界——五轮加场景7 时漏改上界，导致 E2E 崩溃被误判成断言生效');
  const s = windowAfter(LIFECYCLE, 'const scene = async (n, fn) => {', 500);
  assert.ok(/!SCENE_IDS\.includes\(n\)/.test(s), 'scene() 自身也要校验场景号已登记（双向兜底）');
});

test('P2-1（六轮）JZ_KEEP_SABOTAGE 只允许单目标，且必须跳过阶段2', () => {
  // KEEP = 人工观察现场。all + KEEP 会让三个守卫同时失效：
  // ① 现场变成「全守卫失效」的混沌态，没有观察价值；
  // ② 阶段2 会在破坏态下重启 daemon 跑全量 E2E，报出一个误导性的 RESTORE-FAILED
  //    （看起来像「还原有问题」，实际是压根没还原）。
  assert.ok(/if \(keep && keys\.length > 1\)/.test(SABOTAGE),
    'KEEP 模式下多目标必须直接拒绝（逼用户显式指定单目标）');
  const w = windowAfter(SABOTAGE, 'if (keep && keys.length > 1)', 700);
  assert.ok(/fail\(/.test(w), '拒绝必须是 fail()（硬失败），不能只打印警告后继续');

  // 阶段2 之前必须有 KEEP 分支并 return
  const p2 = SABOTAGE.indexOf('// ---- 阶段 2：还原 → 全场景必须 PASS ----');
  assert.notEqual(p2, -1, '应存在阶段2 代码块');
  const before = SABOTAGE.slice(0, p2);
  const keepIdx = before.lastIndexOf('if (keep) {');
  assert.notEqual(keepIdx, -1, '阶段2 之前必须有 KEEP 分支');
  const keepBlock = before.slice(keepIdx, keepIdx + 900);
  assert.ok(/跳过阶段2/.test(keepBlock), 'KEEP 分支必须明确跳过阶段2');
  assert.ok(/\breturn\b/.test(keepBlock), 'KEEP 分支必须 return，不能落到阶段2');
  assert.ok(keepBlock.indexOf('return') < keepBlock.indexOf('await restartDaemon') ||
            !/await restartDaemon/.test(keepBlock),
    'KEEP 分支不得再重启 daemon 跑阶段2');
});

test('P2-1（六轮）KEEP 模式不得写证据文件（避免生成误导性结论）', () => {
  assert.ok(/拒绝写证据：JZ_KEEP_SABOTAGE=1/.test(SABOTAGE),
    'KEEP 是人工观察运行，不是闸门运行，写下的证据不具备验收效力');
  const w = windowAfter(SABOTAGE, 'const writeEvidence = () => {', 400);
  assert.ok(/if \(keep\)/.test(w), 'writeEvidence 必须判 KEEP 并拒写');
});

test('P2-2（六轮）备份缺失必须硬失败：restoreFailed 置位 + 调用方检查返回值', () => {
  // 备份丢了还继续跑，后面所有结论都建立在「源码可能还留着 return true 破坏桩」之上，一律不可信。
  assert.ok(/let restoreFailed = false;/.test(SABOTAGE), '应有模块级 restoreFailed 标志');
  const fn = windowAfter(SABOTAGE, 'function restoreInject(reason)', 1400);
  assert.ok(/if \(!fs\.existsSync\(BACKUP\)\)/.test(fn), '必须检查固定备份是否存在');
  assert.ok(/restoreFailed = true;/.test(fn), '备份缺失时必须置 restoreFailed');
  assert.ok(/return false;/.test(fn), '还原失败必须返回 false（调用方据此阻断）');
  // 写回备份后仍检出破坏桩，同样算还原失败
  assert.ok(/写回备份后仍检出/.test(fn), '写回后必须复检破坏桩标记，不能「复制了就算还原成功」');

  // 调用方：阶段1 每个目标跑完必须检查返回值并 fail
  const loop = windowAfter(SABOTAGE, '// ---- 阶段 1：逐个破坏守卫', 2900);
  assert.ok(/if \(!restoreInject\(`restore:\$\{k\}`\)\)/.test(loop),
    '阶段1 循环里必须检查 restoreInject 的返回值——六轮 P2-2 就是这里只调用不检查');
  assert.ok(/fail\(/.test(loop), '还原失败必须 fail() 终止后续目标与阶段2');

  // 堡垒：finally 兜底还原也失败时，仍要有一道闸拦住阶段2
  assert.ok(/if \(restoreFailed\) \{\s*\n\s*throw new Error\('RESTORE-FAILED/.test(SABOTAGE),
    'finally 之后必须有 restoreFailed 总闸，任何还原失败都不许进入阶段2');

  // 备份丢失是真实场景（macOS 会定期清理 /tmp 里 3 天未访问的文件），必须有故障注入点可复现
  assert.ok(/JZ_SIMULATE_BACKUP_LOSS/.test(SABOTAGE),
    '应提供备份丢失的故障注入点，否则「硬失败」这条路径永远无法回归验证');
  // 注意：文件头注释里也提到这个变量，marker 必须取到真正执行注入的那处
  const inj = windowAfter(SABOTAGE, 'process.env.JZ_SIMULATE_BACKUP_LOSS', 400);
  assert.ok(/unlinkSync\(BACKUP\)/.test(inj), '注入点必须真的删掉固定备份');
});

test('P2-2（六轮）还原失败时禁止写证据（不可信结论比没有结论更糟）', () => {
  const w = windowAfter(SABOTAGE, 'const writeEvidence = () => {', 400);
  assert.ok(/if \(restoreFailed\)/.test(w), 'writeEvidence 必须检查 restoreFailed');
  const guard = SABOTAGE.slice(SABOTAGE.indexOf('const writeEvidence'), SABOTAGE.indexOf('const writeEvidence') + 400);
  assert.ok(/拒绝写证据/.test(guard), '拒绝时应打印明确原因');
  assert.ok(/return false;/.test(guard), '拒绝写证据必须 return false（不落盘 + 通知调用方），不能照写');
});

test('（六轮自查）过滤模式不得覆盖全场景证据文件', () => {
  // 自行发现的洞：sabotage 阶段1 单场景跑 E2E 时，会顺手把「7 场景全 PASS」的正经证据
  // 改写成「只有 1 个场景且 FAIL」——而这恰恰是故意破坏守卫后的预期结果。
  // 一旦误提交，仓库里的正经证据就变成了污染证据，且无从看出是被污染的。
  const w = windowAfter(LIFECYCLE, 'const evidenceName =', 900);
  assert.ok(/only \? 'pay-sync-lifecycle-e2e\.filtered\.json' : 'pay-sync-lifecycle-e2e\.json'/.test(w),
    '过滤模式必须写到 .filtered.json，正经证据只由完整全场景运行产生');
  assert.ok(/fs\.writeFileSync\(evidencePath,/.test(LIFECYCLE),
    '落盘必须走 evidencePath（由 evidenceName 拼出），不得再写死 pay-sync-lifecycle-e2e.json');
  assert.ok(/filtered: only \? only : undefined/.test(w),
    '过滤模式的证据里要记下本次过滤了哪些场景，避免被当成全量结果采信');
});

// ===== A0 七轮 P1-2：三态必须机器可解析，INVALID 不得被记成 caught =====

test('P1-2 E2E 结果输出必须是三态前缀（PASS / FAIL / INVALID）', () => {
  // 混在一起的后果：场景7 挂起失败输出 `FAIL — 7 … 本场景无效（不是产品缺陷）`，
  // 而 judge() 只按 `FAIL — <scene>` 前缀匹配 → 「压根没跑到断言」被记成「守卫失效→场景 FAIL」，
  // 闸门据此写下 caught 证据＝假阳性。
  const w = windowAfter(LIFECYCLE, 'results.forEach((r) => console.log(', 400);
  assert.ok(/r\.pass \? 'PASS' : \(r\.invalid \? 'INVALID' : 'FAIL'\)/.test(w),
    '输出必须是 PASS / INVALID / FAIL 三态前缀，INVALID 与 FAIL 不得共用前缀');
  assert.ok(/const failResult = \(scene, detail, invalid\)/.test(LIFECYCLE),
    '应有 failResult(scene, detail, invalid) 显式标记「非产品缺陷」的失败');
  const invalidCalls = (LIFECYCLE.match(/failResult\([\s\S]*?,\s*true\);/g) || []).length;
  assert.ok(invalidCalls >= 4, `场景4/6 前置不足 + 场景7 构造失败 + 场景7 正向基线不足 都应判 INVALID，实际 ${invalidCalls} 处`);
});

test('P1-2 judge() 必须把 INVALID 判为 invalid，绝不记为 caught', () => {
  const w = windowAfter(SABOTAGE, 'function judge(r, scene)', 700);
  assert.ok(/\(FAIL\|INVALID\) — \$\{scene\}/.test(w), 'judge 必须同时识别 FAIL 与 INVALID 两种前缀');
  assert.ok(/startsWith\('INVALID —'\) \? 'invalid' : 'caught'/.test(w),
    'INVALID 必须判为 invalid（本轮无效），不得记为 caught');
  assert.ok(/phase1 === 'invalid'/.test(SABOTAGE), 'invalid 必须被显式当作失败处理（不进阶段2）');
  const iv = windowAfter(SABOTAGE, "rec.phase1 === 'invalid'", 300);
  assert.ok(/allCaught = false;/.test(iv), 'invalid 必须置 allCaught=false，否则会继续跑阶段2 并生成证据');
});

// ===== A0 七轮 P2-3 / P2-4 / P2-5 / P2-6 =====

test('P2-3 场景7 必须有正向基线，只判上限等于空跑', () => {
  const s7 = windowAfter(LIFECYCLE, '// ---- 场景7（A0 五轮）', 6800);
  assert.ok(/const bBought = await buy\(/.test(s7), '必须捕获 B 单的点击结果');
  // 八轮 P2-4：宽松的 !==/​> 断言在「价格映射错了但仍然变化」时照样通过，
  // 已收紧为钉死期望值——宽松断言不得再出现（防回归）。
  assert.ok(!/amountAfterB !== amountBeforeB/.test(s7), '不得退回「金额只要变了就行」的宽松断言');
  assert.ok(/baselineOk/.test(s7), '正向基线不满足时应判 INVALID 而不是静默通过');
  // B 链必须观测到真的在跑：七轮 all 模式阶段2 实测，B 链因时序偶发没启动时 delta=0，
  // 被误记成产品 FAIL（连带场景6 也成了 INVALID）。「B 链没起来」属构造失败，不是产品缺陷。
  assert.ok(/bChainUp/.test(s7), '必须显式等 B 的同步链跑起来');
  assert.ok(/B 的同步链未启动/.test(s7), 'B 链没启动应判 INVALID（本场景无效），不能记成产品 FAIL');
  // 关键：既要有上界也要有下界。没有下界时，B 链没跑起来（delta≈0）也会被判 PASS。
  assert.ok(/delta <= MAX_DELTA && delta >= MIN_DELTA/.test(s7),
    '刷新增量必须有下界——只判 `delta <= 6` 时「零链/空跑」同样满足');
  assert.ok(/MIN_DELTA = 3/.test(s7), '下界应显式定义并可见');
});

test('P2-4 证据落盘必须 fail-closed（写失败就失败退出，不许只打日志）', () => {
  // lifecycle 侧：原写法 catch 里只打日志继续走 → 「exit 0 但没有可信证据文件」是可能的
  const le = windowAfter(LIFECYCLE, 'const evidenceName = only ?', 1400);
  assert.ok(/let evidenceOk = false;/.test(le), '应有 evidenceOk 标志');
  assert.ok(/JSON\.parse\(fs\.readFileSync\(evidencePath/.test(le), '写完必须回读校验，能解析才算落盘成功');
  assert.ok(/back\.results\.length !== results\.length/.test(le), '回读要校验条数一致');
  assert.ok(/process\.exit\(allPass && evidenceOk \? 0 : 1\)/.test(LIFECYCLE),
    '落盘失败必须让退出码非 0');
  // sabotage 侧（八轮 P2-1：目标路径按 isFullGate 分流到 EVIDENCE 或 EVIDENCE_PARTIAL）
  const se = windowAfter(SABOTAGE, 'const writeEvidence = () => {', 1800);
  assert.ok(/return false;/.test(se), 'writeEvidence 应返回布尔，失败返回 false');
  assert.ok(/JSON\.parse\(fs\.readFileSync\(targetPath/.test(se), 'sabotage 侧同样要回读校验（按分流后的 targetPath）');
  assert.ok(/if \(!writeEvidence\(\)\) throw new Error\('EVIDENCE-FAILED/.test(SABOTAGE),
    '阶段2 的 writeEvidence 返回值必须被检查，落盘失败即失败退出');
});

test('P2-5 JZ_E2E_ONLY 必须逐 token 严格校验，不得静默忽略非法项', () => {
  // 原写法 .filter(x => x > 0) 会把 NaN 丢掉，`3,garbage` 退化成 [3] 合法通过
  assert.ok(!/\.filter\(\(x\) => x > 0\)/.test(LIFECYCLE),
    '不得再用 filter(x>0) —— 它会把非法 token 静默丢掉');
  const w = windowAfter(LIFECYCLE, 'const rawOnly = process.env.JZ_E2E_ONLY', 1600);
  assert.ok(/tok === ''/.test(w), '空项必须报错');
  assert.ok(/!\/\^\\d\+\$\/\.test\(tok\)/.test(w), '每个 token 都必须做严格整数校验，不能只靠 Number() 后过滤 NaN');
  assert.ok(/含非法项/.test(w), '报错信息要指出是哪个 token 非法');
});

test('P2-6 固定备份必须在项目内且独占加锁，不得再放全局 /tmp', () => {
  assert.ok(/const BACKUP = path\.join\(TMP_DIR, 'jz-inject\.sabotage\.backup\.js'\);/.test(SABOTAGE),
    '备份应落在项目内目录，不再直接放 os.tmpdir()');
  assert.ok(/const TMP_DIR = path\.join\(ROOT, '\.tmp-probe'\);/.test(SABOTAGE),
    '.tmp-probe/ 已在 .gitignore 中，且不受系统 /tmp 清理影响');
  assert.ok(!/path\.join\(os\.tmpdir\(\), 'jz-inject/.test(SABOTAGE),
    '不得再把备份放全局 /tmp —— 别的用户可预置同名文件，且 macOS 会清理 3 天未访问的文件');
  // 九轮 P1：锁实现抽到 lib/sabotage-lock.js（行为级竞态测试要用真实锁代码），断言随之改读 LOCK_LIB
  assert.ok(/async function acquireLock\(/.test(LOCK_LIB), '应有并发锁，两个实例并发会互相覆盖备份');
  const lockW = windowAfter(LOCK_LIB, 'async function acquireLock(', 3600);
  assert.ok(/flag: 'wx'/.test(lockW), '锁必须独占创建（wx），已存在则 EEXIST');
  assert.ok(/pidAlive\(holder\.pid\)/.test(lockW), '锁已存在时要判断持有进程是否还活着');
  assert.ok(/mode: 0o600/.test(lockW), '锁文件权限 0600');
  // 八轮 P2-2：nonce 化——锁内容带唯一 nonce，抢到后读回验证
  assert.ok(/lockNonce = `\$\{process\.pid\}/.test(lockW), '锁内容必须带唯一 nonce');
  assert.ok(/back\.nonce !== lockNonce/.test(lockW), '抢到锁后必须读回验证 nonce，被换手则重新评估');
  assert.ok(/fs\.chmodSync\(TMP_DIR, 0o700\)/.test(lockW),
    'mkdirSync 的 mode 只对新建目录生效，已存在时必须显式 chmodSync 收紧权限');
  // 九轮 P1：删除前二次读取比对——内容变了绝不 unlink（后到者删先到者的新锁 = 双持有）
  assert.ok(/if \(cur !== null && cur !== sawRaw\) continue;/.test(lockW),
    '接管陈旧锁前必须二次读取比对，内容变了必须重新评估而不是硬删');
  // 十轮 P1：默认不自动接管陈旧锁（wx 独占创建 ⇒ 可证明互斥），显式 flag 才走尽力接管
  assert.ok(/const takeoverFlag = process\.env\.JZ_TAKEOVER_STALE_LOCK === '1';/.test(lockW),
    '接管必须是显式 opt-in（JZ_TAKEOVER_STALE_LOCK=1），不得默认自动接管');
  assert.ok(/默认不自动接管/.test(lockW) && /rm \$\{LOCKFILE\}/.test(lockW),
    '默认路径遇陈旧锁必须 fail 并给出人工清理命令，绝不 unlink 自己没创建的锁');
  assert.ok(/cur\.nonce !== lockNonce/.test(windowAfter(LOCK_LIB, 'function releaseLock()', 600)),
    '释放前必须校验 nonce，不是自己的锁绝不删');
  assert.ok(/acquireLock\(\);/.test(SABOTAGE), 'main() 里必须真的获取锁');
  assert.ok(/fs\.chmodSync\(BACKUP, 0o600\)/.test(SABOTAGE), '备份文件权限 0600');
  assert.ok(/fs\.readFileSync\(BACKUP, 'utf8'\)\.includes\(SABOTAGE_MARK\)/.test(SABOTAGE),
    '写完备份要自证：备份里若带破坏桩，说明 inject.js 本身就是脏的，必须停下');
  // 锁必须在所有退出路径释放，否则陈旧锁会永久挡住后续运行
  assert.ok(/releaseLock\(\);[\s\S]{0,200}process\.exit\(restoreFailed/.test(SABOTAGE), '信号处理路径要释放锁');
  assert.ok(/\} finally \{\s*\n\s*releaseLock\(\);/.test(SABOTAGE), 'exit 钩子要无条件释放锁（finally）');
});

// ===== A0 十一轮 P1：信号退出必须异步收口（杀子进程 → 父进程清场 → 再还原/退出） =====

test('十一轮 P1：信号退出不得绕过父进程清场（E2E 在飞时 stub 会残留）', () => {
  assert.ok(/let shuttingDown = false;/.test(SABOTAGE), '信号收口必须有重入防护');
  assert.ok(/let currentE2EChild = null;/.test(SABOTAGE) && /currentE2EChild = p;/.test(SABOTAGE),
    'runE2E 必须登记当前子进程，供信号路径定向终止');
  assert.ok(/let e2eEverStarted = false;/.test(SABOTAGE),
    '必须记录本轮是否跑过 E2E——子进程可能异常死亡而没走到自己的 finally，不能赌页面干净');
  const sigW = windowAfter(SABOTAGE, "for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'])", 2600);
  assert.ok(/child\.kill\('SIGKILL'\)/.test(sigW), '信号路径必须先终止在飞的 E2E 子进程');
  assert.ok(/forceCleanupPageStub\(\)/.test(sigW), '信号路径必须执行父进程清场');
  assert.ok(/清场整体超时（20s deadline）/.test(sigW), '信号路径清场必须有 deadline 兜底');
  assert.ok(/restoreInject\(`signal:\$\{sig\}`\)/.test(sigW), '清场后才还原源码');
  assert.ok(/restoreFailed \|\| !c\.ok \? 1 : 130/.test(sigW),
    '清场失败必须非零退出');
  assert.ok(/信号退出时页面清场失败/.test(sigW), '清场失败必须给「刷新页面」指引');
});

// ===== A0 九轮 P1 检查点 + P2 父进程清场 =====

test('九轮 P1：每次动 inject.js 前必须过 ensureLockOurs 检查点', () => {
  assert.ok(/const ensureLockOurs = \(\) => lock\.ensureLockOurs\(\{ fail \}\);/.test(SABOTAGE),
    'sabotage 必须接入锁模块的检查点（fail 注入）');
  const loop = windowAfter(SABOTAGE, '// ---- 阶段 1：逐个破坏守卫', 900);
  assert.ok(/ensureLockOurs\(\);\s*\n\s*sabotage\(t\);/.test(loop),
    '阶段1 每次打桩前必须确认锁仍在自己手里——锁被抢走时大声终止，不静默双写');
  const p2 = windowAfter(SABOTAGE, '// ---- 阶段 2：还原 → 全场景必须 PASS', 400);
  assert.ok(/ensureLockOurs\(\);/.test(p2), '阶段2 开始前同样要过锁检查点');
});

test('九轮 P2：E2E 超时后父进程必须独立清场并验证，清不掉 = 环境污染硬失败', () => {
  assert.ok(/async function forceCleanupPageStub\(\)/.test(SABOTAGE),
    '父进程必须有独立 CDP 清场函数（SIGKILL 跳过了子进程 finally 的 stub 清理）');
  assert.ok(/\[STUB-CLEANUP\]/.test(SABOTAGE), '清场结果必须打标记，供运行者与 judge 辨认');
  const runW = windowAfter(SABOTAGE, 'function runE2E(scenes)', 3000);
  assert.ok(/polluted: !cleanupSettled\.ok/.test(runW), '清场失败必须置 polluted 标记');
  assert.ok(/清场失败：WorkBuddy 页面可能残留 fetch stub（环境污染）/.test(SABOTAGE),
    'polluted 时必须硬失败并给出人工修复指引（刷新页面），不能只重启 daemon');
  assert.ok(/removeStub|__e2eBase/.test(windowAfter(SABOTAGE, 'async function forceCleanupPageStub', 3800)),
    '清场必须真的撤 window.fetch stub（恢复 __e2eBase）');
  // 超时可注入仅限测试路径
  assert.ok(/Number\(process\.env\.JZ_E2E_TIMEOUT_MS\) \|\| 7 \* 60 \* 1000/.test(SABOTAGE),
    'E2E 整体超时上限必须存在且可通过 JZ_E2E_TIMEOUT_MS 注入（行为级测试超时路径用）');
  // 十轮 P1：超时后 close 不得直接结算——必须等齐「子进程退出 + 清场结果」
  assert.ok(/let timedOut = false;/.test(runW), 'runE2E 必须有 timedOut 标记');
  assert.ok(/if \(!timedOut\) finish\(\{ ok: code === 0, out \}\);\s*\n\s*else maybeFinish\(\);/.test(runW),
    'close 在超时后不得直接 finish——否则清场失败的 polluted 会被 settled 分支丢弃');
  // 十轮实测踩坑：SIGKILL 时 close 的 code 为 null，必须用独立 exited 布尔判断是否已退出
  assert.ok(/exited = true;/.test(runW), 'close 处理必须置 exited 标记（SIGKILL 时 code 为 null）');
  assert.ok(/if \(!exited \|\| cleanupSettled === null\) return;/.test(runW),
    '超时结算必须等齐「子进程退出 + 清场结果」，且不得用 code 判断子进程是否退出');
  assert.ok(/清场整体超时（20s deadline）/.test(runW), '清场必须有外层 deadline 兜底');
  // 十轮 P2：清场自身绝不许挂死——建连 deadline、中断拒绝 pending、finally 释放 ws
  const cw = windowAfter(SABOTAGE, 'async function forceCleanupPageStub', 4800);
  assert.ok(/CDP 建连超时（5s）/.test(cw), 'CDP 建连必须有 deadline（半开连接时 open 永不来）');
  assert.ok(/dropAll/.test(cw), '连接中断必须拒绝所有 pending 请求');
  assert.ok(/ws\.terminate\(\)/.test(cw), 'finally 必须无条件释放 WebSocket');
});

// ===== A0 八轮 P2-1 / P2-3（超时）/ P2-4（钉死金额） =====

test('八轮 P2-1 非完整闸门运行不得覆盖权威证据（partial 分流）', () => {
  assert.ok(/const EVIDENCE_PARTIAL = path\.join\(OUT, 'pay-sync-sabotage\.partial\.json'\);/.test(SABOTAGE),
    '应有独立的 partial 证据文件——单目标/JZ_PHASE2=0 的结果不能改写权威结论');
  const w = windowAfter(SABOTAGE, 'const isFullGate = ', 700);
  assert.ok(/key === 'all' && record\.phase2 === 'all-pass'/.test(w),
    'canonical 只认「全目标 + 阶段2 all-pass」，其余一律分流到 partial');
  assert.ok(/const targetPath = isFullGate \? EVIDENCE : EVIDENCE_PARTIAL;/.test(w),
    '非完整闸门必须写 partial 文件');
  assert.ok(/未覆盖权威证据/.test(SABOTAGE), 'partial 落盘时必须明说没有覆盖权威证据，避免读者误当闸门结论');
});

test('八轮 P2-3 E2E 子进程与 CDP 单请求必须有超时（挂死不得让人工 SIGINT 兜底）', () => {
  assert.ok(/const E2E_TIMEOUT_MS = Number\(process\.env\.JZ_E2E_TIMEOUT_MS\) \|\| 7 \* 60 \* 1000;/.test(SABOTAGE),
    'runE2E 必须有整体超时上限');
  // 十轮在 E2E_TIMEOUT_MS 与 runE2E 之间又加厚了 forceCleanupPageStub，窗口随之加宽
  const w = windowAfter(SABOTAGE, 'const E2E_TIMEOUT_MS = ', 6800);
  assert.ok(/SIGKILL/.test(w), '超时到点必须 SIGKILL 子进程，让 finally 还原照常走');
  assert.ok(/E2E-TIMEOUT/.test(w), '超时输出必须带标记，judge 能判 error 而不是悬停');
  assert.ok(/const SEND_TIMEOUT_MS = \d+ \* 1000;/.test(LIFECYCLE), 'CDP send 必须有单请求超时');
  assert.ok(/pending\.delete\(id\)/.test(LIFECYCLE), '超时时必须清理 pending 表');
  assert.ok(/CDP 请求超时/.test(LIFECYCLE), '超时必须 reject，页面挂死不得让 await 无限 pending');
});

test('八轮 P2-4 场景7 金额必须钉死期望值、订单号恰好 +1', () => {
  const s7 = windowAfter(LIFECYCLE, '// ---- 场景7（A0 五轮）', 6800);
  assert.ok(/const EXPECT_A = '¥19\.00';/.test(s7), 'A 单金额必须钉死期望值（coupon→1900 分），宽松断言防不住价格映射错');
  assert.ok(/const EXPECT_B = '¥99\.00';/.test(s7), 'B 单金额必须钉死期望值（yearly→9900 分）');
  assert.ok(/amountBeforeB === EXPECT_A && amountAfterB === EXPECT_B/.test(s7),
    '必须严格等于期望金额，「仍然变化」不算验证');
  assert.ok(/seqAfterB === seqBeforeB \+ 1/.test(s7),
    '订单号必须恰好 +1（__e2eSeq 每次 purchase +1，A/B 相邻购买），其他数字说明场景已脏');
});

test('阶段1 结果必须区分「断言生效」与「E2E 自身崩溃」，不能只看退出码', () => {
  // 崩溃同样是非零退出码，只看 code===0 会把崩溃误判成「守卫失效→场景 FAIL」＝假阳性
  assert.ok(/stdio: \['ignore', 'pipe', 'pipe'\]/.test(SABOTAGE), 'runE2E 必须捕获子进程输出以判别失败原因');
  assert.ok(/function judge\(r, scene\)/.test(SABOTAGE), '应有独立的判定函数');
  const w = windowAfter(SABOTAGE, 'function judge(r, scene)', 700);
  assert.ok(/if \(r\.ok\) return 'ineffective';/.test(w), 'E2E 全过 = 断言空转');
  assert.ok(/\(FAIL\|INVALID\) — \$\{scene\}/.test(w), '必须确认输出里真的有目标场景的 FAIL/INVALID 行');
  assert.ok(/return 'error';/.test(w), '其余非零退出一律判为 error（本轮无效），绝不记为 caught');
  assert.ok(/phase1 === 'error'/.test(SABOTAGE), 'error 必须被显式当作失败处理');
});
