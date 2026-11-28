import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { withAuth } from "@/lib/api-middleware";
import { sanitizeInput, createAuditLog, ipFromRequest } from "@/lib/security";

export const GET = withAuth(async (request, { user }) => {
  try {
    if (!user.companyId) {
      return NextResponse.json({ error: "Company context required" }, { status: 403 });
    }
    const { searchParams } = new URL(request.url);
    const category = searchParams.get("category");
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "10", 10) || 10));

    const where: Record<string, unknown> = { companyId: user.companyId };
    if (category) where.category = category;
    if (from || to) {
      const dateFilter: Record<string, Date> = {};
      if (from) dateFilter.gte = new Date(from);
      if (to) dateFilter.lte = new Date(to);
      where.date = dateFilter;
    }

    const skip = (page - 1) * limit;
    const [expenses, total] = await Promise.all([
      db.expense.findMany({
        where,
        orderBy: { date: "desc" },
        skip,
        take: limit,
      }),
      db.expense.count({ where }),
    ]);

    return NextResponse.json({
      data: expenses,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Expenses GET error:", error);
    return NextResponse.json({ error: "Failed to fetch expenses" }, { status: 500 });
  }
});

export const POST = withAuth(async (request, { user }) => {
  try {
    if (!user.companyId) {
      return NextResponse.json({ error: "Company context required" }, { status: 403 });
    }
    const body = await request.json();
    const description = body.description ? sanitizeInput(String(body.description)) : "";
    const title = body.title ? sanitizeInput(String(body.title)) : description.slice(0, 120);
    const amount = Number(body.amount);
    const category = body.category ? sanitizeInput(String(body.category)) : "general";
    const dateInput = body.date || body.expenseDate;
    const date = dateInput ? new Date(dateInput) : new Date();

    if (!title || !Number.isFinite(amount)) {
      return NextResponse.json({ error: "Title/description and valid amount are required" }, { status: 400 });
    }

    const expense = await db.expense.create({
      data: {
        companyId: user.companyId,
        title,
        description: description || null,
        amount,
        category,
        date,
        createdBy: user.userId,
      },
    });

    await createAuditLog({
      userId: user.userId,
      companyId: user.companyId,
      action: "create",
      resource: "expense",
      resourceId: expense.id,
      details: { title, description, amount, category, date: date.toISOString() },
      ipAddress: ipFromRequest(request),
    });

    return NextResponse.json({ data: expense }, { status: 201 });
  } catch (error) {
    console.error("Expenses POST error:", error);
    return NextResponse.json({ error: "Failed to create expense" }, { status: 500 });
  }
}, { minRole: "accountant" });
