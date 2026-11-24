import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-middleware';

// Compatibility endpoint. Tenant membership changes go through /api/team;
// do not expose edits to a global User through a tenant-scoped URL.
const unavailable = withAuth(async () => NextResponse.json({ error: 'Not found' }, { status: 404 }));
export { unavailable as GET, unavailable as PATCH, unavailable as DELETE };
