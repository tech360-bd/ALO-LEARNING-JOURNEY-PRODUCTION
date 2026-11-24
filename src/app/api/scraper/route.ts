import { publicHttp } from '@/lib/public-http';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { verifyToken } from '@/lib/auth';
import { enrichByDomain } from '@/lib/enrichment';
import { emitEvent } from '@/lib/events';

// POST /api/scraper — scrape a URL for research (firecrawl pattern)
// Body: { url: string, mode?: "summary" | "metadata" | "full" }
//
// Modes:
//   - "summary" (default): Strip HTML, return first 500 chars + title + meta description
//   - "metadata": Just <title>, <meta> tags, no body
//   - "full": Strip HTML, return up to 10k chars of text + all metadata
//
// Also tries to create a Lead if the URL contains an email or contact info.
export async function POST(req: NextRequest) {
  try {
    const token = req.headers.get('Authorization')?.replace('Bearer ', '');
    if (!token) return NextResponse.json({ error: 'No token' }, { status: 401 });
    const payload = await verifyToken(token);
    if (!payload || !payload.companyId) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    }

    const body = await req.json();
    const url = String(body.url || '').trim();
    if (!url) return NextResponse.json({ error: 'url is required' }, { status: 400 });
    if (!/^https?:\/\//i.test(url)) {
      return NextResponse.json({ error: 'URL must start with http:// or https://' }, { status: 400 });
    }

    const mode = ['summary', 'metadata', 'full'].includes(body.mode) ? body.mode : 'summary';

    const { status, text: html } = await publicHttp(url);
    if (status < 200 || status >= 300) return NextResponse.json({ error: 'Retrieval failed' }, { status: 502 });
    const finalUrl = url;
    const domain = new URL(finalUrl).hostname.replace(/^www\./, '');

    // Extract metadata
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : null;

    const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
    const description = descMatch ? descMatch[1].trim() : null;

    const ogSiteMatch = html.match(/<meta\s+property=["']og:site_name["']\s+content=["']([^"']+)["']/i);
    const siteName = ogSiteMatch ? ogSiteMatch[1].trim() : null;

    const ogImageMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
    const ogImage = ogImageMatch ? ogImageMatch[1].trim() : null;

    // Extract contact emails (regex)
    const emailMatches = Array.from(new Set(
      (html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [])
        .filter((e) => !e.endsWith('.png') && !e.endsWith('.jpg') && !e.endsWith('.gif'))
    )).slice(0, 5);

    // Extract phone numbers (very loose regex — US-format)
    const phoneMatches = Array.from(new Set(
      html.match(/\+?1?[-. ]?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}/g) || []
    )).slice(0, 3);

    // Strip HTML for text body
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();

    const maxChars = mode === 'full' ? 10000 : mode === 'summary' ? 500 : 0;
    const textBody = maxChars > 0 ? text.slice(0, maxChars) : '';

    // Try enrichment if we have a domain
    let enrichment: Awaited<ReturnType<typeof enrichByDomain>> | null = null;
    if (mode !== 'metadata') {
      try {
        enrichment = await enrichByDomain(domain);
      } catch {
        // enrichment is best-effort
      }
    }

    // Fire event for the scrape
    await emitEvent({
      companyId: payload.companyId,
      userId: payload.userId,
      type: 'scraper.url_scraped',
      title: 'URL scraped',
      description: `Scraped ${domain} — ${emailMatches.length} emails, ${phoneMatches.length} phones found`,
      resourceType: 'scraper',
      link: undefined,
      metadata: { url: finalUrl, domain, emailCount: emailMatches.length, phoneCount: phoneMatches.length },
    });

    return NextResponse.json({
      data: {
        url: finalUrl,
        domain,
        title,
        description,
        siteName,
        ogImage,
        emails: emailMatches,
        phones: phoneMatches,
        text: textBody,
        textLength: text.length,
        enrichment,
        scrapedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.warn('[scraper] retrieval failed');
    return NextResponse.json({ error: 'Scrape failed' }, { status: 500 });
  }
}
