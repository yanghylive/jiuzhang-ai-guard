/**
 * [pay-kit 模板] 套餐 code → 标准档位名映射（真源: kaypal-ai src/lib/gateway/app-entitlement-check.ts
 * buildMembershipSnapshot，2026-09-01 容器 patch 96080 已同步回源码树）
 *
 * 作用：会员快照对外暴露的 plan 名做归一——宿主套餐 code 可以随便起名，
 * 但网关/权益层只认标准档位（PRO/ADVANCED/FLAGSHIP/FREE）。
 * miss 时回落原 code：新套餐没配映射不会 500，只是档位名裸露（低风险降级）。
 *
 * 【接入改点】新应用上线时在这里加自己的套餐映射行即可，底座"只加不改"。
 */

export const PLAN_CODE_TO_TIER: Record<string, string> = {
  pro: 'PRO',
  team: 'ADVANCED',
  business: 'FLAGSHIP',
  free: 'FREE',
  private_deployment: 'FLAGSHIP',
  enterprise: 'FLAGSHIP',
  // jz-ai-guard（九章AI管家）按 PRO 档授予
  jz_guard_yearly: 'PRO',
  jz_guard_yearly_coupon: 'PRO',
  jz_guard_lifetime_early: 'PRO',
};

export function planCodeToTier(code: string): string {
  return PLAN_CODE_TO_TIER[code] ?? code;
}
