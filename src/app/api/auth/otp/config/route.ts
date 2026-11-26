import { NextResponse } from "next/server";
import {
  adminPasswordHashStatus,
  isAdminAuthenticationConfigured,
  isAdminOtpDeliveryConfigured,
  isAdminOtpRequired,
} from "@/lib/auth-config";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(
    {
      required: isAdminOtpRequired(),
      available: isAdminOtpDeliveryConfigured(),
      authConfigured: isAdminAuthenticationConfigured(),
      // Never the value itself — only which of the two documented failure modes
      // applies, so the login page can show the operator the real cause.
      passwordHash: adminPasswordHashStatus().state,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
