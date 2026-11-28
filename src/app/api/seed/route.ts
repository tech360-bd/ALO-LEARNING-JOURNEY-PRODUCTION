import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwnerOrResponse } from "@/lib/auth";
import { ensureSeeded } from "@/lib/seed";

export async function POST() {
  const auth = await requireOwnerOrResponse();
  if (auth.response) return auth.response;
  await ensureSeeded();
  // Idempotent: returns counts after ensuring seed
  const [companies, ideas, packages, approvals, connections, ragDocs] = await Promise.all([
    db.company.count(),
    db.contentIdea.count(),
    db.contentPackage.count(),
    db.approvalItem.count(),
    db.socialConnection.count(),
    db.ragDocument.count(),
  ]);
  return NextResponse.json({
    seeded: true,
    counts: { companies, ideas, packages, approvals, connections, ragDocs },
  });
}
