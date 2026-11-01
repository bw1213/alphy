import { NextResponse } from "next/server";
import { loadData, type DataRequest } from "@/lib/data/server";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as DataRequest;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.start) || !/^\d{4}-\d{2}-\d{2}$/.test(body.end)) {
      return NextResponse.json({ error: "날짜 형식은 YYYY-MM-DD" }, { status: 400 });
    }
    if (body.tickers) body.tickers = body.tickers.filter((t) => /^[0-9A-Z]{6}$/.test(t));
    body.universeSize = Math.min(Math.max(body.universeSize ?? 100, 1), 300);
    return NextResponse.json(await loadData(body));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
