// ─── MarketingOS Security Utilities ────────────────────────────────────
// Rate limiting, input sanitization, audit logging, permission checks
// ───────────────────────────────────────────────────────────────────────────────

import { isIP } from "node:net";
import { db } from "@/lib/db";
import { hasPermission } from "@/lib/auth";

// ─── Rate Limiter ──────────────────────────────────────────────────────────────

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    if (now > entry.resetAt) {
      rateLimitStore.delete(key);
    }
  }
}, 60_000).unref();

export interface RateLimitOptions {
  maxRequests?: number;
  windowMs?: number;
}

export function rateLimiter(
  ip: string,
  options: RateLimitOptions = {}
): { allowed: boolean; retryAfterMs: number } {
  const { maxRequests = 100, windowMs = 60_000 } = options;
  const key = `rl:${ip}`;
  const now = Date.now();
  const entry = rateLimitStore.get(key);

  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterMs: 0 };
  }

  if (entry.count >= maxRequests) {
    return { allowed: false, retryAfterMs: entry.resetAt - now };
  }

  entry.count++;
  return { allowed: true, retryAfterMs: 0 };
}

// ─── Input Sanitization ────────────────────────────────────────────────────────

export function sanitizeInput(input: string): string {
  return input
    .trim()
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, "")
    .replace(/\bon\w+\s*=\s*\S+/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/javascript\s*:/gi, "")
    .replace(/data\s*:/gi, "")
    .replace(/vbscript\s*:/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ─── Audit Logging ─────────────────────────────────────────────────────────────

export interface AuditLogData {
  userId?: string;
  companyId?: string;
  action: string;
  resource: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
}

export async function createAuditLog(data: AuditLogData): Promise<void> {
  try {
    const cleanIp = data.ipAddress && isIP(data.ipAddress.trim()) > 0 ? data.ipAddress.trim() : undefined;
    const payload =
      data.details || cleanIp
        ? JSON.stringify({
            ...(data.details || {}),
            ...(cleanIp ? { ipAddress: cleanIp } : {}),
          })
        : null;

    await db.mosAuditLog.create({
      data: {
        userId: data.userId || null,
        companyId: data.companyId || null,
        action: data.action,
        resource: data.resource,
        resourceId: data.resourceId || null,
        details: payload,
      },
    });
  } catch (error) {
    console.error("Failed to create audit log:", error);
  }
}

// ─── Permission Validation ─────────────────────────────────────────────────────

export function validatePermission(
  userPermissions: Record<string, boolean>,
  requiredPermission: string
): boolean {
  if (userPermissions["super_admin"]) return true;
  return Boolean(userPermissions[requiredPermission]);
}

// ─── IP Extraction ─────────────────────────────────────────────────────────────

/**
 * Extract and validate the client IP address from reverse-proxy headers.
 * Rejects non-IP strings (log injection / header spoofing) via `node:net` `isIP`.
 * Prefers single-value proxy-set headers (`x-real-ip`, `cf-connecting-ip`, `true-client-ip`),
 * and takes the rightmost valid hop from `x-forwarded-for` (appended by the trusted proxy).
 */
export function ipFromRequest(request: Request): string {
  const singleHeaders = [
    "x-real-ip",
    "cf-connecting-ip",
    "true-client-ip",
  ];
  for (const header of singleHeaders) {
    const raw = request.headers.get(header)?.trim();
    if (raw && isIP(raw) > 0) {
      return raw;
    }
  }

  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    // Reverse proxy appends the real client IP on the right; left-side entries can be spoofed.
    for (let i = parts.length - 1; i >= 0; i--) {
      if (isIP(parts[i]) > 0) {
        return parts[i];
      }
    }
  }

  return "127.0.0.1";
}

// ─── Role Hierarchy (single source of truth from auth.ts) ───────────────────────

/** @deprecated Use `hasPermission` from @/lib/auth instead */
export const ROLE_HIERARCHY = {
  super_admin: 100,
  company_owner: 90,
  admin: 80,
  manager: 70,
  social_media_manager: 60,
  content_manager: 60,
  seo_manager: 60,
  ai_agent_manager: 60,
  customer_support: 50,
  team_member: 40,
  client_user: 30,
  viewer: 20,
} as const;

/** @deprecated Use `hasPermission` from @/lib/auth instead */
export function hasMinRole(userRole: string, requiredRole: string): boolean {
  return hasPermission(userRole, requiredRole);
}
