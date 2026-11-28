import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { hashPassword, issueSessionToken } from '@/lib/auth';

// `/api/auth/*` is public in src/proxy.ts (next-auth needs it), so on the
// production site this endpoint is reachable by anyone. Self-service MarketingOS
// sign-up therefore fails closed in production unless explicitly enabled;
// bootstrap the first account with `prisma/seed.ts` instead.
function registrationEnabled(): boolean {
  return process.env.NODE_ENV !== 'production' || process.env.MARKETINGOS_ALLOW_REGISTRATION === 'true';
}

export async function POST(req: NextRequest) {
  if (!registrationEnabled()) {
    return NextResponse.json(
      { error: 'Self-service registration is disabled on this deployment.' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  try {
    const { email, password, name, companyName, industry, country } = (await req.json().catch(() => null)) ?? {};
    if (typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email) || email.length > 254 || typeof password !== 'string' || password.length < 8 || typeof name !== 'string' || !name.trim() ||
        [companyName, industry, country].some(value => value != null && typeof value !== 'string')) {
      return NextResponse.json({ error: 'Valid email, name and password (8+ characters) required' }, { status: 400 });
    }

    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      return NextResponse.json({ error: 'Email already registered' }, { status: 409 });
    }

    const passwordHash = await hashPassword(password);
    const { user, company, token } = await db.$transaction(async tx => {
      const user = await tx.user.create({
        data: { email, passwordHash, name },
      });

      const slug = (companyName || name).toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 50);
      const company = await tx.mosCompany.create({
        data: {
          name: companyName || `${name}'s Company`,
          slug,
          industry: industry || '',
          country: country || '',
          plan: 'free',
        },
      });

      await tx.companyUser.create({
        data: {
          userId: user.id,
          companyId: company.id,
          role: 'company_owner',
          permissions: JSON.stringify({ all: true }),
        },
      });

      const token = await issueSessionToken(tx, {
        userId: user.id,
        email: user.email,
        role: 'company_owner',
        companyId: company.id,
      }, req.headers.get('user-agent'));

      // Create default AI agents
      const defaultAgents = [
        { name: 'SEO Agent', type: 'seo', desc: 'Automated SEO analysis and optimization' },
        { name: 'Content Writer', type: 'content', desc: 'AI-powered content creation' },
        { name: 'Social Media Manager', type: 'social', desc: 'Social media post creation and scheduling' },
        { name: 'Lead Generator', type: 'lead_gen', desc: 'Automated lead generation and qualification' },
        { name: 'Analytics Agent', type: 'analytics', desc: 'Performance tracking and insights' },
      ];
      for (const agent of defaultAgents) {
        await tx.aiAgent.create({ data: { name: agent.name, type: agent.type, description: agent.desc, config: '{}', companyId: company.id } });
      }
      return { user, company, token };
    });

    return NextResponse.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: 'company_owner',
        companyId: company.id,
        companyName: company.name,
        plan: 'free',
      },
    });
  } catch (error) {
    if ((error as { code?: string })?.code === 'P2002') {
      return NextResponse.json({ error: 'Email or company name already registered' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
