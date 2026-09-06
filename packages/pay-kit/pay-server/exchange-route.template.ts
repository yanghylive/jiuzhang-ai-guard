/**
 * [pay-kit 模板] 桌面端短时会话交换路由（真源: kaypal-ai src/app/api/desktop-auth/exchange/route.ts）
 *
 * 作用：桌面长期令牌（kda_，存 DB 表 desktopAccessToken）换 15 分钟 HS256 短时 JWT，
 * 桌面端以 Cookie `<COOKIE_NAME>=<jwt>` 调用订阅/支付类路由。
 *
 * 设计要点（勿改坏）：
 * - 不用平台的 createAuthToken：它强制 jti + Redis 白名单链；15min 一次性会话不需要撤销能力，
 *   避免支付链路引入 Redis 依赖。
 * - payload 必含 tenantId：微信下单 metadata 强制非空 tenantId。
 * - 校验语义对齐 get-current-user：token 有效 + 设备 active + 用户未禁用，三层 fail-closed。
 *
 * 【接入改点】
 * 1. desktopAccessToken 表：换成宿主自己的长期令牌表（字段: tokenHash/revokedAt/expiresAt/userId/deviceId）
 * 2. JWT_SECRET / JWT_ISSUER：宿主 env
 * 3. COOKIE_NAME：与 pay-core 副本的 cookie 名一致（jz 用 kaypal_auth）
 * 4. tenantId 取值路径：按宿主 User 表结构调整
 */

export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { SignJWT } from 'jose';
import { prisma } from '@/lib/db'; // 【接入改点 1】宿主 DB 客户端
import { hashDesktopSecret } from '@/lib/desktop-auth';

const DEFAULT_ISSUER = 'kaypal-ai-platform';
const EXCHANGE_TTL_SECONDS = 900; // 15 分钟

const exchangeSchema = z.object({
  access_token: z.string().min(1),
});

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET ?? '';
  return new TextEncoder().encode(secret);
}

export async function POST(request: NextRequest) {
  try {
    const raw = await request.json();
    const parsed = exchangeSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: '参数校验失败', details: parsed.error.flatten() }, { status: 400 });
    }

    const now = new Date();
    const record = await prisma.desktopAccessToken.findUnique({
      where: { tokenHash: hashDesktopSecret(parsed.data.access_token) },
      include: { user: true, device: true },
    });

    // 三层 fail-closed：token 有效 + 设备 active + 用户未禁用
    if (!record || record.revokedAt || record.expiresAt <= now) {
      return NextResponse.json({ error: 'access_token 无效或已过期' }, { status: 401 });
    }
    if (record.device.revokedAt || record.device.status !== 'active') {
      return NextResponse.json({ error: '设备已注销' }, { status: 401 });
    }
    if (!record.user || record.user.disabledAt) {
      return NextResponse.json({ error: '账号不可用' }, { status: 401 });
    }

    // tenantId：支付 metadata 必需（payment/create 强制非空 tenantId）
    const payload = {
      userId: record.user.id,
      email: record.user.email ?? '',
      tenantId: (record.user as { tenantId?: string }).tenantId ?? '', // 【接入改点 4】
    };
    const issuer = process.env.JWT_ISSUER ?? DEFAULT_ISSUER;
    const jwt = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(issuer)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + EXCHANGE_TTL_SECONDS)
      .sign(getSecret());

    return NextResponse.json({
      access_token: jwt,
      token_type: 'kaypal_auth',
      expires_in: EXCHANGE_TTL_SECONDS,
      user: { id: record.user.id, email: record.user.email },
    });
  } catch (e) {
    console.error('POST /api/desktop-auth/exchange', e);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
