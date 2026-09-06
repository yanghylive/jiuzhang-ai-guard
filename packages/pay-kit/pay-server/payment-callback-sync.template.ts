/**
 * [pay-kit 模板] 支付回调 → 订阅同步（真源: kaypal-ai src/lib/pricing/service.ts handlePaymentCallback，
 * 2026-09-01 容器 patch 4422 已同步回源码树）
 *
 * 作用：微信回调确认支付成功后，把订单状态落 paid 并同步订阅表——
 *   过期旧 active/trialing 订阅 → 按套餐周期建新 active 订阅 → （可选）发放权益积分。
 *
 * 周期推导规则（planId 字符串语义）：
 *   含 "lifetime" → 永久（endDate=null，不动 subscriptionPeriodEnd）
 *   含 "yearly"   → +365 天
 *   其余           → +30 天
 *
 * 硬纪律（血泪，勿破坏）：
 * - 同步失败只 warn 不 throw——发积分/落订单是主链路，订阅表同步失败不能把支付回调整挂。
 * - 幂等：handlePaymentCallback 开头 order.status==='paid' 直接 return（微信回调可能重推）。
 * - 金额校验容忍 0.01 元浮点误差（PAYMENT_AMOUNT_MISMATCH 在回调前置层做）。
 *
 * 【接入改点】
 * 1. 表名映射：subscriptionOrder/userSubscription/subscriptionPlanProduct → 宿主对应表
 * 2. 周期推导规则：按宿主套餐命名调整（或改成 planProduct 表配置驱动）
 * 3. grantCredits：换成宿主权益发放（没有积分体系就整段删掉）
 */

const SUBSCRIPTION_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const SUBSCRIPTION_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

// 支付成功后的订阅同步段（生产实锤逻辑，照抄自 kaypal-ai pricing/service.ts）。
// 入参: { prisma, order } —— order 为已校验金额、待落 paid 的订阅订单行。
export async function syncSubscriptionOnPaid(prisma: any, order: any): Promise<void> {
  // 周期按 planId 语义推导：lifetime 永久（无 endDate）、yearly +365 天、其余按月 +30 天。
  const planIdText = String(order.planId ?? '');
  const billingCycle = planIdText.includes('lifetime')
    ? 'lifetime'
    : planIdText.includes('yearly')
      ? 'yearly'
      : 'monthly';
  const subscriptionEnd =
    billingCycle === 'lifetime'
      ? null
      : billingCycle === 'yearly'
        ? new Date(Date.now() + SUBSCRIPTION_YEAR_MS)
        : new Date(Date.now() + SUBSCRIPTION_MONTH_MS);
  const now = new Date();

  // user.subscriptionPeriodEnd = 旧字段兼容（宿主没有这字段就删掉这段）
  if (subscriptionEnd) {
    await prisma.user.update({
      where: { id: order.userId },
      data: { subscriptionPeriodEnd: subscriptionEnd },
    });
  }

  // 订阅同步：过期旧订阅 + 建 active 新订阅。失败仅 warn 不阻断主链路。
  try {
    await prisma.userSubscription.updateMany({
      where: { userId: order.userId, status: { in: ['active', 'trialing'] } },
      data: { status: 'expired', autoRenew: false, updatedAt: now },
    });
    const planProduct = await prisma.subscriptionPlanProduct.findFirst({
      where: { OR: [{ id: order.planId }, { code: order.planId }] },
      orderBy: { updatedAt: 'desc' },
    });
    if (planProduct) {
      await prisma.userSubscription.create({
        data: {
          userId: order.userId,
          planId: planProduct.id,
          billingCycle,
          status: 'active',
          startDate: now,
          endDate: subscriptionEnd,
          nextBillingDate: billingCycle === 'lifetime' ? null : subscriptionEnd,
          autoRenew: false,
          lastPaymentAt: now,
          updatedAt: now,
        },
      });
    }
  } catch (error) {
    console.warn('handlePaymentCallback userSubscription sync failed', error);
  }
}
