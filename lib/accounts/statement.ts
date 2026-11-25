
export interface TextItem { str: string; x: number; y: number; w: number }
export type Page = TextItem[];

export class PdfPasswordError extends Error {
  constructor(public wrong: boolean) { super(wrong ? "PDF 암호가 맞지 않습니다." : "암호가 걸린 PDF입니다. 암호를 넣어 주세요."); }
}

interface PdfLib {
  getDocument: (src: { data: Uint8Array; password?: string; isEvalSupported?: boolean; disableFontFace?: boolean }) => { promise: Promise<any> };
}

export async function readPdfText(pdfjs: PdfLib, data: Uint8Array, password = ""): Promise<Page[]> {
  let doc: any;
  try {
    doc = await pdfjs.getDocument({ data, password: password || undefined, isEvalSupported: false, disableFontFace: true }).promise;
  } catch (e: any) {
    if (e?.name === "PasswordException") throw new PdfPasswordError(e.code === 2 || !!password);
    throw new Error(`PDF를 열지 못했습니다: ${e?.message ?? e}`);
  }
  const pages: Page[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const [a, b, c, d, e, f] = page.getViewport({ scale: 1 }).transform as number[];
    const tc = await page.getTextContent();
    pages.push(tc.items.filter((t: any) => typeof t.str === "string" && t.str.trim()).map((t: any) => {
      const [tx, ty] = [t.transform[4], t.transform[5]];
      return { str: t.str.trim(), x: a * tx + c * ty + e, y: b * tx + d * ty + f, w: t.width };
    }));
  }
  await doc.destroy?.();
  return pages;
}

export function pageLines(page: Page): string[] {
  const rows: { y: number; items: TextItem[] }[] = [];
  for (const t of [...page].sort((a, b) => a.y - b.y)) {
    const r = rows.find((x) => Math.abs(x.y - t.y) < 2.5);
    if (r) r.items.push(t); else rows.push({ y: t.y, items: [t] });
  }
  return rows.map((r) => r.items.sort((a, b) => a.x - b.x).map((t) => t.str).join("  "));
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function findLabel(page: Page, re: RegExp): TextItem | undefined {
  const plain = (t: string) => t.replace(/\s/g, "");
  const one = page.find((x) => re.test(plain(x.str)));
  if (one) return one;
  const sorted = [...page].sort((a, b) => a.y - b.y || a.x - b.x);
  for (let i = 0; i < sorted.length; i++) {
    let s = "";
    for (let j = i; j < Math.min(sorted.length, i + 12); j++) {
      const t = sorted[j];
      if (Math.abs(t.y - sorted[i].y) > 2 || (j > i && t.x - (sorted[j - 1].x + sorted[j - 1].w) > Math.max(6, sorted[j - 1].w))) break;
      s += plain(t.str);
      if (j > i && re.test(s)) return { str: s, x: sorted[i].x, y: sorted[i].y, w: t.x + t.w - sorted[i].x };
    }
  }
  return undefined;
}
const NUM = /^-?[\d,]+(\.\d+)?$/;
const num = (s: string) => Number(s.replace(/,/g, ""));
const center = (t: TextItem) => t.x + t.w / 2;

export interface StatementRow {
  date: string;
  kind: string;
  ticker?: string;
  name?: string;
  qty?: number;
  price?: number;
  amount?: number;
  fee?: number;
  note?: string;
  currency?: "USD";
  balance?: number;
}

export interface StatementResult {
  broker: string;
  rows: StatementRow[];
  checked: number;
  mismatches: string[];
  skipped: string[];
  fx?: number;
}

type Col = "qty" | "amount" | "fee" | "repay" | "balance" | "unpaid";
const HEAD1: [Col, RegExp][] = [["qty", /^수량$/], ["amount", /^거래금액$/], ["fee", /^수수료/], ["repay", /^상환/], ["balance", /^원화예수금$/], ["unpaid", /^미수/]];

function columns(page: Page): { cols: { col: Col; c: number }[]; textLeft: number; textRight: number; top: number } | null {
  const found: { col: Col; c: number; y: number }[] = [];
  for (const [col, re] of HEAD1) {
    const t = findLabel(page, re);
    if (t) found.push({ col, c: center(t), y: t.y });
  }
  if (!found.some((f) => f.col === "qty") || !found.some((f) => f.col === "amount") || !found.some((f) => f.col === "balance")) return null;
  const memo = findLabel(page, /^(적요|종목명)$/);
  const head = [/^잔고수량$/, /^정산금액$/, /^단가$/].flatMap((re) => findLabel(page, re) ?? []);
  const top = Math.max(...found.map((f) => f.y), ...head.map((h) => h.y));
  const qtyC = found.find((f) => f.col === "qty")!.c;
  const no = findLabel(page, /^거래No$/i);
  const textRight = memo ? (center(memo) + qtyC) / 2 : qtyC - 80;
  return { cols: found.sort((a, b) => a.c - b.c).map(({ col, c }) => ({ col, c })), textLeft: no ? no.x + no.w + 2 : textRight - 120, textRight, top };
}

function colOf(cols: { col: Col; c: number }[], x: number): Col {
  let best = cols[0];
  for (let i = 0; i < cols.length; i++) {
    const lo = i === 0 ? -Infinity : (cols[i - 1].c + cols[i].c) / 2;
    const hi = i === cols.length - 1 ? Infinity : (cols[i].c + cols[i + 1].c) / 2;
    if (x >= lo && x < hi) best = cols[i];
  }
  return best.col;
}

function kindOf(text: string): string | null {
  const s = text.replace(/\s/g, "");
  if (/입고/.test(s)) return "입고";
  if (/출고/.test(s)) return "출고";
  if (/\[매수\]|매수/.test(s)) return "매수";
  if (/\[매도\]|매도/.test(s)) return "매도";
  if (/배당|분배/.test(s)) return "배당";
  if (/이자/.test(s)) return "이자";
  if (/\[입금\]/.test(s)) return "입금";
  if (/\[출금\]/.test(s)) return /세금|수수료/.test(s) ? "비용" : "출금";
  if (/입금/.test(s)) return "입금";
  if (/출금/.test(s)) return "출금";
  return null;
}

const SIGN: Record<string, number> = { 입금: 1, 매도: 1, 배당: 1, 이자: 1, 출금: -1, 매수: -1, 비용: -1, 입고: 0, 출고: 0 };

export function parseHanwha(pages: Page[]): StatementResult {
  const rows: StatementRow[] = [];
  const skipped: string[] = [];
  let cols: ReturnType<typeof columns> = null;
  for (const page of pages) {
    cols = columns(page) ?? cols;
    if (!cols) continue;
    const { cols: cs, textLeft, textRight } = cols;
    const top = columns(page)?.top ?? 0;
    const anchors = page.filter((t) => DATE.test(t.str) && t.x < textRight && t.y > top).sort((a, b) => a.y - b.y);
    if (!anchors.length) continue;
    const gaps = anchors.slice(1).map((a, i) => a.y - anchors[i].y).filter((g) => g > 5).sort((a, b) => a - b);
    const step = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 32;
    anchors.forEach((a, i) => {
      const lo = a.y - step / 4;
      const hi = Math.min(a.y + (3 * step) / 4, anchors[i + 1] ? anchors[i + 1].y - step / 4 : Infinity);
      const items = page.filter((t) => t !== a && t.y >= lo && t.y < hi);
      const line1 = (t: TextItem) => Math.abs(t.y - a.y) < step / 4;
      const nums: Partial<Record<`${Col}${1 | 2}`, number>> = {};
      const text1: string[] = [], text2: string[] = [];
      for (const t of items.sort((p, q) => p.y - q.y || p.x - q.x)) {
        if (NUM.test(t.str) && center(t) > textRight) {
          const k = `${colOf(cs, center(t))}${line1(t) ? 1 : 2}` as const;
          if (nums[k] === undefined) nums[k] = num(t.str);
        } else if (t.x >= textLeft && center(t) < textRight + 40) {
          (line1(t) || t.y < a.y ? text1 : text2).push(t.str);
        }
      }
      const desc = text1.join(" ");
      const kind = kindOf(desc);
      const label = `${a.str} ${desc.slice(0, 30)}`;
      if (/취소/.test(desc)) { skipped.push(`${label} (취소 거래)`); return; }
      if (!kind) { skipped.push(`${label} (구분을 알 수 없음)`); return; }
      const all2 = text2.join(" ");
      const m = all2.match(/\[A?([0-9A-Z]{6})\]\s*(.*)$/);
      const amount = nums.amount1;
      const settle = nums.amount2;
      const row: StatementRow = { date: a.str, kind, ...(nums.balance1 !== undefined ? { balance: nums.balance1 } : {}) };
      if (kind === "매수" || kind === "매도" || kind === "입고" || kind === "출고") {
        if (!m) { skipped.push(`${label} (종목을 못 찾음)`); return; }
        row.ticker = m[1];
        if (m[2].trim()) row.name = m[2].trim();
        row.qty = nums.qty1;
        if (nums.qty2 !== undefined) row.price = nums.qty2;
        if (kind === "매수" || kind === "매도") {
          if (nums.fee1 !== undefined || nums.fee2 !== undefined) row.fee = (nums.fee1 ?? 0) + (nums.fee2 ?? 0);
          else if (amount !== undefined && settle !== undefined) row.fee = Math.abs(settle - amount);
        }
        if (row.qty === undefined || ((kind === "매수" || kind === "매도") && row.price === undefined)) { skipped.push(`${label} (수량·단가를 못 읽음)`); return; }
      } else {
        row.amount = amount ?? settle;
        if (!row.amount) { skipped.push(`${label} (금액을 못 읽음)`); return; }
        if (m) { row.ticker = m[1]; if (m[2].trim()) row.name = m[2].trim(); }
      }
      const note = desc.replace(/^\[[^\]]*\]\s*/, "").trim();
      if (note && !["매수", "매도"].includes(kind)) row.note = note.slice(0, 40);
      (row as any)._settle = settle ?? amount;
      rows.push(row);
    });
  }
  const mismatches: string[] = [];
  let checked = 0;
  for (let i = 1; i < rows.length; i++) {
    const p = rows[i - 1], r = rows[i];
    const s = (r as any)._settle as number | undefined;
    if (p.balance === undefined || r.balance === undefined || s === undefined || !SIGN[r.kind]) continue;
    checked++;
    const want = p.balance + SIGN[r.kind] * s;
    if (Math.abs(want - r.balance) > 1) mismatches.push(`${r.date} ${r.kind}${r.name ? ` ${r.name}` : ""}: 예수금 ${want.toLocaleString("ko-KR")}원이어야 하는데 ${r.balance.toLocaleString("ko-KR")}원`);
  }
  for (const r of rows) delete (r as any)._settle;
  return { broker: "한화투자증권", rows, checked, mismatches, skipped };
}

export function toLedgerTsv(rows: StatementRow[]): string {
  const cell = (v: unknown) => (v === undefined || v === null ? "" : String(v).replace(/[\t\n]/g, " "));
  return ["날짜\t구분\t종목\t수량\t가격\t금액\t수수료\t통화\t메모", ...rows.map((r) => [r.date, r.kind, r.ticker ? (r.name ? `${r.name} (${r.ticker})` : r.ticker) : "", r.qty, r.price, r.amount, r.fee, r.currency, r.note].map(cell).join("\t"))].join("\n");
}

const MDATE = /^(\d{4})[/.-](\d{2})[/.-](\d{2})$/;

function splitDates(page: Page): Page {
  return page.flatMap((t) => {
    const m = t.str.match(/^(\d{4}[/.-]\d{2}[/.-]\d{2})\s+(.+)$/);
    if (!m) return [t];
    const k = m[1].length / t.str.length;
    return [{ ...t, str: m[1], w: t.w * k }, { ...t, str: m[2], x: t.x + t.w * (1 - m[2].length / t.str.length), w: (t.w * m[2].length) / t.str.length }];
  });
}

type MCol = "date" | "kind" | "code" | "fee" | "amount" | "balance" | "fxAmount" | "fxBalance" | "due" | "dueNew"
  | "no" | "orig" | "qty" | "price" | "name" | "tax" | "cash" | "hold" | "fxCash" | "fxHold" | "cur" | "dueRepay";
const MHEAD1: [MCol, RegExp][] = [["date", /^거래일자$/], ["kind", /^거래종류$/], ["code", /^종목번호/], ["fee", /^수수료$/], ["amount", /^거래금액$/], ["balance", /^예수금잔액$/], ["fxAmount", /^외화거래금액$/], ["fxBalance", /^외화예수금$/], ["due", /^미수총잔고$/], ["dueNew", /^미수발생금액$/]];
const MHEAD2: [MCol, RegExp][] = [["no", /^거래번호$/], ["orig", /^원번호$/], ["qty", /^거래수량$/], ["price", /^단가$/], ["name", /^종목명$/], ["tax", /^제세금합$/], ["cash", /^입출금액$/], ["hold", /^유가잔고$/], ["fxCash", /^외화입출금액$/], ["fxHold", /^외화유가잔고$/], ["cur", /^통화코드$/], ["dueRepay", /^미수변제금액$/]];

function miraeColumns(page: Page) {
  const find = (heads: [MCol, RegExp][]) => heads.flatMap(([col, re]) => {
    const t = findLabel(page, re);
    return t ? [{ col, c: center(t), y: t.y }] : [];
  }).sort((a, b) => a.c - b.c);
  const l1 = find(MHEAD1), l2 = find(MHEAD2);
  const has = (l: typeof l1, c: MCol) => l.some((x) => x.col === c);
  if (!has(l1, "balance") || !has(l1, "code") || !has(l2, "qty") || !has(l2, "cash")) return null;
  return { l1, l2, top: Math.max(...l1.map((x) => x.y), ...l2.map((x) => x.y)) };
}

const rightOf = (cols: { col: MCol; c: number }[], right: number) => [...cols].reverse().find((x) => x.c < right)?.col;
const leftOf = (cols: { col: MCol; c: number }[], left: number) => cols.find((x) => x.c > left)?.col;

function miraeKind(s: string): { kind: string; leg?: "cash" | "fx" } | null {
  if (/환전|외화매수|외화매도|선환전|환차/.test(s)) return { kind: "환전", leg: "fx" };
  if (/(매수|매도)(출금|입금)$/.test(s)) return { kind: "결제", leg: "cash" };
  if (/매수입고$|펀드.*매수|매수$/.test(s)) return { kind: "매수" };
  if (/매도출고$|환매|매도$/.test(s)) return { kind: "매도" };
  if (/배당|분배/.test(s)) return { kind: "배당" };
  if (/이자|이용료/.test(s)) return { kind: "이자" };
  if (/입고/.test(s)) return { kind: "입고" };
  if (/출고/.test(s)) return { kind: "출고" };
  if (/(세금|수수료|제비용).*출금|출금.*(세금|수수료)/.test(s)) return { kind: "비용" };
  if (/입금/.test(s)) return { kind: "입금" };
  if (/출금/.test(s)) return { kind: "출금" };
  return null;
}

const krCode = (s: string) => {
  const t = s.replace(/\s/g, "").toUpperCase();
  const m = t.match(/^A?(\d[0-9A-Z]{5})$/);
  return m ? m[1] : t;
};

export function parseMirae(pages: Page[]): StatementResult {
  const rows: StatementRow[] = [];
  const skipped: string[] = [];
  const mismatches: string[] = [];
  let checked = 0, fx = 0, bal: number | undefined;
  let cols: ReturnType<typeof miraeColumns> = null;
  for (const raw of pages) {
    const page = splitDates(raw);
    const here = miraeColumns(page);
    cols = here ?? cols;
    if (!cols) continue;
    const { l1, l2 } = cols;
    const top = here?.top ?? 0;
    const textRight = l1.find((x) => x.col === "fee")?.c ?? Infinity;
    const anchors = page.filter((t) => MDATE.test(t.str) && t.y > top + 2 && t.x < textRight).sort((a, b) => a.y - b.y);
    if (!anchors.length) continue;
    const gaps = anchors.slice(1).map((a, i) => a.y - anchors[i].y).filter((g) => g > 5).sort((a, b) => a - b);
    const step = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 40;
    anchors.forEach((a, i) => {
      const lo = a.y - step / 4;
      const hi = Math.min(a.y + (3 * step) / 4, anchors[i + 1] ? anchors[i + 1].y - step / 4 : Infinity);
      const n: Partial<Record<MCol, number>> = {};
      const kindText: string[] = [], code: string[] = [], name: TextItem[] = [];
      let cur = "";
      for (const t of page.filter((x) => x !== a && x.y >= lo && x.y < hi).sort((p, q) => p.y - q.y || p.x - q.x)) {
        const first = Math.abs(t.y - a.y) < step / 4;
        const cs = first ? l1 : l2;
        if (NUM.test(t.str)) {
          const c = rightOf(cs, t.x + t.w);
          if (c && n[c] === undefined) n[c] = num(t.str);
          continue;
        }
        const c = leftOf(cs, t.x);
        if (first) { if (c === "date" || c === "kind") kindText.push(t.str); else if (c === "code") code.push(t.str); }
        else if (c === "cur" && /^[A-Z]{3}$/.test(t.str)) cur = t.str;
        else if (c === "name" || c === "price" || c === "qty") name.push(t);
      }
      const [, y, mo, d] = a.str.match(MDATE)!;
      const date = `${y}-${mo}-${d}`;
      const desc = kindText.join("").replace(/\s/g, "");
      const label = `${date} ${desc.slice(0, 30)}`;
      const won = n.cash ?? n.amount;
      const usd = cur === "USD" || /^해외/.test(desc) || (won === undefined && (n.fxCash ?? n.fxAmount) !== undefined);
      const cashSign = /입금$|환매/.test(desc) ? 1 : /출금$|매수$/.test(desc) ? -1 : 0;
      if (cashSign && won !== undefined && !/취소/.test(desc)) {
        const now = n.balance ?? 0;
        if (bal !== undefined) {
          checked++;
          const want = bal + cashSign * won;
          if (Math.abs(want - now) > 1) mismatches.push(`${date} ${desc}: 예수금 ${want.toLocaleString("ko-KR")}원이어야 하는데 ${now.toLocaleString("ko-KR")}원`);
        }
        bal = now;
      } else if (n.balance !== undefined) bal = n.balance;
      if (/취소|정정/.test(desc)) { skipped.push(`${label} (취소·정정 거래)`); return; }
      const k = miraeKind(desc);
      if (!k) { skipped.push(`${label} (구분을 알 수 없음)`); return; }
      if (k.leg === "fx") { fx++; return; }
      if (k.leg === "cash") return;
      const ticker = code.length ? krCode(code.join("")) : undefined;
      const nm = name.map((t, j) => (j && Math.abs(t.y - name[j - 1].y) < 2.5 ? " " : "") + t.str).join("").trim();
      const row: StatementRow = { date, kind: k.kind, ...(usd ? { currency: "USD" as const } : {}) };
      if (ticker && !/^USD\d/.test(ticker)) { row.ticker = ticker; if (nm && nm !== "미국달러") row.name = nm; }
      if (["매수", "매도", "입고", "출고"].includes(k.kind)) {
        if (!row.ticker) { skipped.push(`${label} (종목을 못 찾음)`); return; }
        row.qty = n.qty;
        const gross = usd ? n.fxAmount : n.amount;
        if (row.qty) row.price = gross !== undefined && (n.price === undefined || Math.abs(n.price * row.qty - gross) > Math.max(1, gross * 0.01)) ? +(gross / row.qty).toFixed(6) : n.price;
        if (k.kind === "매수" || k.kind === "매도") row.fee = +((n.fee ?? 0) + (n.tax ?? 0)).toFixed(usd ? 2 : 0);
        if (!row.qty || ((k.kind === "매수" || k.kind === "매도") && !row.price)) { skipped.push(`${label} (수량·단가를 못 읽음)`); return; }
      } else {
        const amt = usd ? n.fxCash ?? n.fxAmount : n.cash ?? n.amount;
        if (!amt) { skipped.push(`${label} (금액을 못 읽음)`); return; }
        row.amount = amt;
        if (!["입금", "출금"].includes(k.kind) || desc !== k.kind) row.note = desc.slice(0, 40);
      }
      rows.push(row);
    });
  }
  return { broker: "미래에셋증권", rows, checked, mismatches, skipped, ...(fx ? { fx } : {}) };
}

export function parseStatement(pages: Page[]): StatementResult {
  const m = parseMirae(pages);
  const h = parseHanwha(pages);
  return m.rows.length + m.skipped.length >= h.rows.length + h.skipped.length ? m : h;
}
