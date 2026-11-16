import { NextResponse } from "next/server";
import { requireUser } from "@/lib/settings/auth";
import { OWNER_ID } from "@/lib/settings/userdir";
import { loadSettings } from "@/lib/settings/store";
import { botToken, loadNotify, newLinkCode, notify, setBotToken, unlink, verifyLink } from "@/lib/auto/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 텔레그램 연결 상태 (토큰 자체는 내보내지 않음) */
export async function GET(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  const n = loadNotify(user.id);
  return NextResponse.json({
    botSet: !!botToken(), bot: loadSettings().auto.telegramBot ?? null, owner: user.id === OWNER_ID,
    linked: !!n.chatId, chatName: n.chatName ?? null, code: n.chatId ? null : n.code ?? null,
  }, { headers: { "Cache-Control": "no-store" } });
}

/** { action: "token", token } (owner) | "code" | "verify" | "test" | "unlink" */
export async function POST(req: Request) {
  const { user, denied } = requireUser(req);
  if (denied) return NextResponse.json({ error: denied[1] }, { status: denied[0] });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "요청 형식 오류" }, { status: 400 }); }
  try {
    switch (body?.action) {
      case "token":
        if (user.id !== OWNER_ID) return NextResponse.json({ error: "봇 연결은 관리자만 할 수 있습니다." }, { status: 403 });
        return NextResponse.json({ ok: true, bot: await setBotToken(String(body.token ?? "")) });
      case "code":
        return NextResponse.json({ code: newLinkCode(user.id), bot: loadSettings().auto.telegramBot ?? null });
      case "verify": {
        const n = await verifyLink(user.id);
        return NextResponse.json({ ok: true, chatName: n.chatName });
      }
      case "test": {
        const sent = await notify(user.id, "[알피] 시험 알림입니다. 저녁 계산 결과가 이렇게 옵니다.");
        if (!sent) return NextResponse.json({ error: "봇 또는 내 대화방이 연결되지 않았습니다." }, { status: 400 });
        return NextResponse.json({ ok: true });
      }
      case "unlink":
        unlink(user.id);
        return NextResponse.json({ ok: true });
      default:
        return NextResponse.json({ error: "알 수 없는 요청" }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
