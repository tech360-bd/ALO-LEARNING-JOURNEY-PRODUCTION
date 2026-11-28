import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { withAuth } from "@/lib/api-middleware";
import { sanitizeInput, createAuditLog, ipFromRequest } from "@/lib/security";

export const GET = withAuth(async (_request, { params, user }) => {
  try {
    if (!user.companyId) {
      return NextResponse.json({ error: "Company context required" }, { status: 403 });
    }
    const { id } = (await params) as { id: string };
    const expense = await db.expense.findFirst({
      where: { id, companyId: user.companyId },
    });

    if (!expense) {
      return NextResponse.json({ error: "Expense not found" }, { status: 404 });
    }

    return NextResponse.json({ data: expense });
  } catch (error) {
    console.error("Expense GET by id error:", error);
    return NextResponse.json({ error: "Failed to fetch expense" }, { status: 500 });
  }
});

export const PUT = withAuth(async (request, { params, user }) => {
  try {
    if (!user.companyId) {
      return NextResponse.json({ error: "Company context required" }, { status: 403 });
    }
    const { id } = (await params) as { id: string };
    const existing = await db.expense.findFirst({ where: { id, companyId: user.companyId } });
    if (!existing) {
      return NextResponse.json({ error: "Expense not found" }, { status: 404 });
    }

    const body = await request.json();
    const data: Record<string, unknown> = {};
    if (body.title !== undefined) data.title = sanitizeInput(String(body.title));
    if (body.description !== undefined) data.description = body.description ? sanitizeInput(String(body.description)) : null;
    if (body.amount !== undefined && Number.isFinite(Number(body.amount))) data.amount = Number(body.amount);
    if (body.category !== undefined) data.category = body.category ? sanitizeInput(String(body.category)) : "general";
    if (body.date !== undefined || body.expenseDate !== undefined) {
      const rawDate = body.date ?? body.expenseDate;
      data.date = rawDate ? new Date(rawDate) : new Date();
    }
    if (body.status !== undefined) data.status = sanitizeInput(String(body.status));

    const expense = await db.expense.update({
      where: { id: existing.id },
      data,
    });

    await createAuditLog({
      userId: user.userId,
      companyId: user.companyId,
      action: "update",
      resource: "expense",
      resourceId: id,
      details: data,
      ipAddress: ipFromRequest(request),
    });

    return NextResponse.json({ data: expense });
  } catch (error) {
    console.error("Expense PUT error:", error);
    return NextResponse.json({ error: "Failed to update expense" }, { status: 500 });
  }
}, { minRole: "accountant" });

export const DELETE = withAuth(async (request, { params, user }) => {
  try {
    if (!user.companyId) {
      return NextResponse.json({ error: "Company context required" }, { status: 403 });
    }
    const { id } = (await params) as { id: string };
    const existing = await db.expense.findFirst({ where: { id, companyId: user.companyId } });
    if (!existing) {
      return NextResponse.json({ error: "Expense not found" }, { status: 404 });
    }

    await db.expense.delete({ where: { id: existing.id } });

    await createAuditLog({
      userId: user.userId,
      companyId: user.companyId,
      action: "delete",
      resource: "expense",
      resourceId: id,
      details: { title: existing.title, description: existing.description, amount: existing.amount },
      ipAddress: ipFromRequest(request),
    });

    return NextResponse.json({ data: { message: "Expense deleted successfully" } });
  } catch (error) {
    console.error("Expense DELETE error:", error);
    return NextResponse.json({ error: "Failed to delete expense" }, { status: 500 });
  }
}, { minRole: "accountant" });
