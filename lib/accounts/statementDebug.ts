import fs from "fs";
import { userFile, writeUserFile } from "../settings/userdir";

const MAX = 8_000_000;

export function saveStatementDebug(user: string, pages: unknown, name: string): void {
  if (!Array.isArray(pages)) throw new Error("PDF 글자를 받지 못했습니다.");
  const clean = pages.slice(0, 200).map((pg) => (Array.isArray(pg) ? pg.slice(0, 5000).map((t: any) => ({ str: String(t?.str ?? "").slice(0, 200), x: +Number(t?.x).toFixed(1), y: +Number(t?.y).toFixed(1), w: +Number(t?.w).toFixed(1) })) : []));
  const data = JSON.stringify({ at: new Date().toISOString(), name: name.slice(0, 100), pages: clean });
  if (data.length > MAX) throw new Error("PDF가 너무 커서 보내지 못했습니다.");
  writeUserFile("statement-debug.json", data, user);
}

export function loadStatementDebug(user: string): unknown {
  try { return JSON.parse(fs.readFileSync(userFile("statement-debug.json", user), "utf8")); } catch { return null; }
}
