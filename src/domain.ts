// 資料模型、儲存與排序邏輯
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

/* ───────── 型別 ───────── */

// 顯化循環：1→4→2→8→5→7，3/6/9 為每日儀式節點
export const VORTEX = [1, 4, 2, 8, 5, 7] as const;
export type VortexStage = (typeof VORTEX)[number];

export const VORTEX_INFO: Record<VortexStage, { name: string; focus: string; question: string }> = {
  1: { name: "起心 Intention", focus: "把渴望寫成明確、現在式的目標", question: "達成時，你會看到、聽到、感受到什麼？為什麼對你重要？" },
  4: { name: "藍圖 Structure", focus: "拆成里程碑與專案，定義成功指標", question: "要達成它，必經的 3–5 個里程碑是什麼？各自的完成標準？" },
  2: { name: "連結 Connect", focus: "連結人生清單、資源、人脈與既有專案", question: "這個目標服務哪個人生清單項目？誰或什麼資源能幫你？" },
  8: { name: "行動 Act", focus: "每天推進最小可行動作，累積動能", question: "今天能做的最小一步是什麼？做完會更接近哪個里程碑？" },
  5: { name: "調整 Adjust", focus: "回顧數據與感受，修正方向或範圍", question: "哪些有效、哪些卡住？需要放大、縮小還是換路線？" },
  7: { name: "收成 Harvest", focus: "完成、慶祝、感恩、內化經驗", question: "你學到什麼？要感謝誰？下一個循環要帶著什麼出發？" },
};

export type Status = "todo" | "doing" | "waiting" | "done" | "dropped";
export type Energy = "low" | "medium" | "high";

export interface LifeItem {
  id: string; title: string; area: string; why?: string;
  createdAt: string; achievedAt?: string;
}

export interface Goal {
  id: string; title: string;
  vision: string;          // 達成畫面（現在式描述）
  why: string;             // 內在動機
  affirmation: string;     // 369 儀式用的肯定句
  metric?: string;         // 衡量指標
  targetDate?: string;     // YYYY-MM-DD
  area: string;            // 人生領域：健康/事業/財務/關係/學習/心靈…
  importance: number;      // 1–5
  lifeItemId?: string;
  stage: VortexStage;
  cycles: number;          // 已完成循環數
  status: "active" | "paused" | "achieved" | "dropped";
  createdAt: string; updatedAt: string;
  journal: { at: string; stage: VortexStage; note: string }[];
}

export interface Project {
  id: string; name: string; goalId?: string; description?: string;
  source?: string; // 例如 taskmaster:/path
  archived: boolean; createdAt: string;
}

export interface Task {
  id: string; title: string; notes?: string;
  projectId?: string; goalId?: string;
  status: Status;
  importance?: number;     // 1–5，未填則繼承目標
  due?: string;            // YYYY-MM-DD
  effortMin?: number;      // 預估分鐘
  energy?: Energy;
  tags: string[];
  dependsOn: string[];
  parentId?: string;
  recurDays?: number;      // 完成後 N 天再生
  createdAt: string; updatedAt: string; completedAt?: string;
  log: { at: string; note: string }[];
  scheduled?: Scheduled;
}

export interface Scheduled { start: string; end: string; eventId?: string; calendarId?: string; planId?: string }

export interface CalWindow { days: number[]; start: string; end: string; energy?: Energy } // days: 0=日 … 6=六
export interface CalendarSettings {
  windows: CalWindow[];
  bufferMin: number; maxBlocksPerDay: number; defaultEffortMin: number; minBlockMin: number;
  horizonDays: number; quadrants: ("Q1" | "Q2" | "Q3" | "Q4")[];
  calendarId: string; eventPrefix: string; colorId?: string; allDayBusy: boolean; snapMin: number;
  maxBlocksOffDay: number;   // 週末／國定假日每日上限
  holidays: string[];        // 平日放假 → 套用週日時段
  workdays: string[];        // 週末補班 → 套用週一時段
  directOnly: boolean;       // true：只走直連（私人帳號），不讓 connector 寫入其他帳號
}

/** 台灣政府行政機關辦公日曆：平日放假日（含補假）。來源：人事行政總處 115、116 年辦公日曆表 */
export const TW_HOLIDAYS = [
  // 2026（115 年）10 月起
  "2026-10-26", "2026-12-25",
  // 2027（116 年）
  "2027-01-01", "2027-02-04", "2027-02-05", "2027-02-08", "2027-02-09", "2027-02-10",
  "2027-03-01", "2027-04-05", "2027-04-06", "2027-04-30", "2027-06-09", "2027-09-15",
  "2027-09-28", "2027-10-11", "2027-10-25", "2027-12-24", "2027-12-31",
];
export const TW_WORKDAYS: string[] = []; // 115 下半年、116 年無補班
export const DEFAULT_CAL: CalendarSettings = {
  // 平日 07:30–16:30 上班 → 只排下班後；週末／國定假日排白天
  windows: [
    { days: [1, 2, 3, 4, 5], start: "17:30", end: "18:30", energy: "low" },
    { days: [1, 2, 3, 4, 5], start: "19:30", end: "21:30", energy: "medium" },
    { days: [0, 6], start: "09:00", end: "12:00", energy: "high" },
    { days: [0, 6], start: "14:00", end: "17:00", energy: "medium" },
    { days: [0, 6], start: "19:30", end: "21:00", energy: "low" },
  ],
  bufferMin: 10, maxBlocksPerDay: 2, maxBlocksOffDay: 3, defaultEffortMin: 60, minBlockMin: 25,
  horizonDays: 7, quadrants: ["Q2"], calendarId: "primary", eventPrefix: "🎯", colorId: "9",
  allDayBusy: false, snapMin: 15, holidays: TW_HOLIDAYS, workdays: TW_WORKDAYS, directOnly: true,
};

export interface PlanItem { taskId: string; title: string; start: string; end: string; summary: string; description: string }
export interface Plan { id: string; createdAt: string; items: PlanItem[]; skipped: { taskId: string; title: string; reason: string }[]; holidays?: string[] }

export interface RitualEntry { date: string; slot: "morning" | "noon" | "evening"; goalIds: string[]; note?: string }

export interface Data {
  version: 1;
  lifeList: LifeItem[]; goals: Goal[]; projects: Project[]; tasks: Task[];
  rituals: RitualEntry[]; gratitude: { date: string; text: string }[];
  seq: Record<string, number>;
  settings?: { calendar?: Partial<CalendarSettings> };
  pendingPlan?: Plan;
}

/* ───────── 儲存（JSON，原子寫入） ───────── */

export const DATA_PATH = process.env.MANIFEST_TODO_DATA
  ?? path.join(os.homedir(), ".manifest-todo", "data.json");

const empty = (): Data => ({ version: 1, lifeList: [], goals: [], projects: [], tasks: [], rituals: [], gratitude: [], seq: {} });

export async function load(): Promise<Data> {
  try { return { ...empty(), ...JSON.parse(await fs.readFile(DATA_PATH, "utf8")) }; }
  catch (e: any) { if (e.code === "ENOENT") return empty(); throw e; }
}

export async function save(d: Data) {
  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
  const tmp = DATA_PATH + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(d, null, 2));
  await fs.rename(tmp, DATA_PATH);
}

let queue: Promise<unknown> = Promise.resolve();
/** 序列化讀改寫，避免並行工具呼叫互相覆蓋 */
export function mutate<T>(fn: (d: Data) => T | Promise<T>): Promise<T> {
  const run = queue.then(async () => { const d = await load(); const r = await fn(d); await save(d); return r; });
  queue = run.catch(() => {});
  return run;
}

export const newId = (d: Data, prefix: string) => {
  if (typeof d.seq !== "object") d.seq = {};
  d.seq[prefix] = (d.seq[prefix] ?? 0) + 1;
  return `${prefix}${d.seq[prefix]}`;
};
export const now = () => new Date().toISOString();

/** 台灣時區今天 YYYY-MM-DD */
export function today(tz = process.env.TZ_NAME ?? "Asia/Taipei") {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
}
export function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
}

/* ───────── 輕重緩急評分 ───────── */

export function urgencyOf(due: string | undefined, ref = today()): number {
  if (!due) return 1;
  const d = daysBetween(ref, due);
  if (d <= 1) return 5;   // 逾期、今天、明天
  if (d <= 3) return 4;
  if (d <= 7) return 3;
  if (d <= 14) return 2;
  return 1;
}

export const QUADRANT = {
  Q1: "Q1 重要且緊急 → 立刻做",
  Q2: "Q2 重要不緊急 → 排進行程（顯化主戰場）",
  Q3: "Q3 緊急不重要 → 快速處理或委派",
  Q4: "Q4 不重要不緊急 → 考慮刪除",
} as const;

export interface Scored {
  task: Task; goal?: Goal; project?: Project;
  importance: number; urgency: number; quadrant: keyof typeof QUADRANT;
  score: number; blockedBy: string[]; reasons: string[];
}

export function scoreTasks(d: Data, opts: { energy?: Energy; maxMin?: number } = {}): Scored[] {
  const ref = today();
  const byId = new Map(d.tasks.map(t => [t.id, t]));
  const out: Scored[] = [];
  for (const t of d.tasks) {
    if (t.status === "done" || t.status === "dropped") continue;
    const project = d.projects.find(p => p.id === t.projectId);
    if (project?.archived) continue;
    const goal = d.goals.find(g => g.id === (t.goalId ?? project?.goalId));
    if (goal && goal.status !== "active") continue;

    const importance = t.importance ?? goal?.importance ?? 3;
    const urgency = urgencyOf(t.due, ref);
    const quadrant = importance >= 4 ? (urgency >= 4 ? "Q1" : "Q2") : (urgency >= 4 ? "Q3" : "Q4");
    const blockedBy = t.dependsOn.filter(id => { const x = byId.get(id); return x && x.status !== "done" && x.status !== "dropped"; });
    const reasons: string[] = [];

    let score = importance * 2 + urgency * 1.5;
    if (t.due && daysBetween(ref, t.due) < 0) { score += 2; reasons.push(`逾期 ${-daysBetween(ref, t.due)} 天`); }
    if (goal) { reasons.push(`推進目標「${goal.title}」`); if (goal.stage === 8) score += 1; }
    if (goal?.lifeItemId) { score += 0.5; reasons.push("連結人生清單"); }
    if (t.status === "doing") { score += 1.5; reasons.push("進行中，先收尾"); }
    if (t.status === "waiting") score -= 3;
    if (t.effortMin && t.effortMin <= 15) { score += 0.5; reasons.push("15 分鐘內可完成"); }
    if (opts.energy && t.energy) {
      if (t.energy === opts.energy) score += 1;
      else if (opts.energy === "low" && t.energy === "high") score -= 2;
    }
    if (opts.maxMin && t.effortMin && t.effortMin > opts.maxMin) score -= 3;
    if (blockedBy.length) score -= 10;
    out.push({ task: t, goal, project, importance, urgency, quadrant, score: Math.round(score * 10) / 10, blockedBy, reasons });
  }
  return out.sort((a, b) => b.score - a.score || (a.task.due ?? "9999").localeCompare(b.task.due ?? "9999"));
}

export function goalProgress(d: Data, g: Goal) {
  const pids = new Set(d.projects.filter(p => p.goalId === g.id).map(p => p.id));
  const ts = d.tasks.filter(t => (t.goalId === g.id || (t.projectId && pids.has(t.projectId))) && t.status !== "dropped");
  const done = ts.filter(t => t.status === "done").length;
  return { total: ts.length, done, pct: ts.length ? Math.round((done / ts.length) * 100) : 0 };
}

export function nextStage(s: VortexStage): { stage: VortexStage; wrapped: boolean } {
  const i = VORTEX.indexOf(s);
  return i === VORTEX.length - 1 ? { stage: 1, wrapped: true } : { stage: VORTEX[i + 1], wrapped: false };
}

/* ───────── 時區工具 ───────── */

export const TZ = () => process.env.TZ_NAME ?? "Asia/Taipei";

function tzOffsetMs(utcMs: number, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}
/** 當地牆上時間 → UTC ms */
export function localToUtc(date: string, hhmm: string, tz = TZ()) {
  const [y, m, d] = date.split("-").map(Number); const [h, mi] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off = tzOffsetMs(guess - tzOffsetMs(guess, tz), tz);
  return guess - off;
}
/** UTC ms → 當地 "YYYY-MM-DDTHH:mm:ss"（無 offset，Google connector 要的格式） */
export function utcToLocalIso(ms: number, tz = TZ()) {
  return new Date(ms + tzOffsetMs(ms, tz)).toISOString().slice(0, 19);
}
/** 解析 ISO：有 Z/offset 照實；沒有則視為當地時間；純日期回 null（全天） */
export function parseInstant(s: string, tz = TZ()): number | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) return Date.parse(s);
  const [date, time = "00:00"] = s.split("T");
  return localToUtc(date, time.slice(0, 5), tz) + (Number(time.slice(6, 8)) || 0) * 1000;
}
const addDays = (date: string, n: number) => new Date(Date.parse(date) + n * 86400000).toISOString().slice(0, 10);
const WEEK = "日一二三四五六";

/* ───────── 排程引擎 ───────── */

export function calSettings(d: Data): CalendarSettings { return { ...DEFAULT_CAL, ...(d.settings?.calendar ?? {}) }; }

/** 國定假日視為週日、補班日視為週一 */
export function effectiveDow(cfg: CalendarSettings, date: string) {
  if (cfg.holidays.includes(date)) return 0;
  if (cfg.workdays.includes(date)) return 1;
  return new Date(Date.parse(date)).getUTCDay();
}
export const isOffDay = (cfg: CalendarSettings, date: string) => [0, 6].includes(effectiveDow(cfg, date));

type Interval = { s: number; e: number; energy?: Energy; date: string };

function subtract(free: Interval[], bs: number, be: number): Interval[] {
  const out: Interval[] = [];
  for (const f of free) {
    if (be <= f.s || bs >= f.e) { out.push(f); continue; }
    if (bs > f.s) out.push({ ...f, e: bs });
    if (be < f.e) out.push({ ...f, s: be });
  }
  return out;
}

export interface BusyInput { start: string; end: string; title?: string }

export function buildPlan(d: Data, opts: {
  busy: BusyInput[]; nowMs?: number; horizonDays?: number; quadrants?: CalendarSettings["quadrants"]; limit?: number; taskIds?: string[];
}): Plan {
  const cfg = calSettings(d); const tz = TZ();
  const nowMs = opts.nowMs ?? Date.now();
  const startDate = utcToLocalIso(nowMs, tz).slice(0, 10);
  const horizon = opts.horizonDays ?? cfg.horizonDays;
  const buf = cfg.bufferMin * 60000;
  const quadrants = opts.quadrants ?? cfg.quadrants;

  // 1. 可排時段
  let free: Interval[] = [];
  for (let i = 0; i < horizon; i++) {
    const date = addDays(startDate, i);
    const dow = effectiveDow(cfg, date);
    for (const w of cfg.windows.filter(w => w.days.includes(dow))) {
      const s = Math.max(localToUtc(date, w.start, tz), nowMs + buf), e = localToUtc(date, w.end, tz);
      if (e - s >= cfg.minBlockMin * 60000) free.push({ s, e, energy: w.energy, date });
    }
  }
  // 2. 扣掉忙碌（行事曆 + 已排任務）
  const busy: { s: number; e: number }[] = [];
  for (const b of opts.busy) {
    const s = parseInstant(b.start, tz), e = parseInstant(b.end, tz);
    if (s === null || e === null) {
      if (cfg.allDayBusy) busy.push({ s: localToUtc(b.start.slice(0, 10), "00:00", tz), e: localToUtc(b.end.slice(0, 10), "00:00", tz) });
      continue;
    }
    busy.push({ s, e });
  }
  for (const t of d.tasks) if (t.scheduled && t.status !== "done" && t.status !== "dropped") busy.push({ s: Date.parse(t.scheduled.start), e: Date.parse(t.scheduled.end) });
  for (const b of busy) free = subtract(free, b.s - buf, b.e + buf);
  free = free.filter(f => f.e - f.s >= cfg.minBlockMin * 60000).sort((a, b) => a.s - b.s);

  // 3. 依分數挑任務
  const scored = scoreTasks(d).filter(r =>
    (opts.taskIds ? opts.taskIds.includes(r.task.id) : quadrants.includes(r.quadrant)) &&
    r.task.status !== "waiting" &&
    !(r.task.scheduled && Date.parse(r.task.scheduled.end) > nowMs));
  const planned = new Map<string, number>(); // taskId → 排定結束時間
  const perDay = new Map<string, number>();
  for (const t of d.tasks) if (t.scheduled && Date.parse(t.scheduled.end) > nowMs) {
    const day = utcToLocalIso(Date.parse(t.scheduled.start), tz).slice(0, 10); perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  const items: PlanItem[] = []; const skipped: Plan["skipped"] = [];
  const limit = opts.limit ?? 20;

  for (const r of scored) {
    if (items.length >= limit) break;
    const t = r.task;
    // 前置任務：已完成，或已在本計畫／行事曆上排在前面
    let earliest = nowMs; let blocked = false;
    for (const dep of r.blockedBy) {
      const depTask = d.tasks.find(x => x.id === dep);
      const end = planned.get(dep) ?? (depTask?.scheduled ? Date.parse(depTask.scheduled.end) : undefined);
      if (end === undefined) { blocked = true; break; }
      earliest = Math.max(earliest, end + buf);
    }
    if (blocked) { skipped.push({ taskId: t.id, title: t.title, reason: `前置任務 ${r.blockedBy.join(",")} 未完成也未排程` }); continue; }
    const dur = (t.effortMin ?? cfg.defaultEffortMin) * 60000;
    const dueEnd = t.due ? localToUtc(addDays(t.due, 1), "00:00", tz) : Infinity;
    const snap = (ms: number) => { const g = cfg.snapMin * 60000; return Math.ceil(ms / g) * g; };
    const fits = (f: Interval, strictEnergy: boolean) => {
      const s = snap(Math.max(f.s, earliest));
      if (f.e - s < dur || s + dur > dueEnd) return false;
      if ((perDay.get(f.date) ?? 0) >= (isOffDay(cfg, f.date) ? cfg.maxBlocksOffDay : cfg.maxBlocksPerDay)) return false;
      if (strictEnergy && t.energy === "high" && f.energy && f.energy !== "high") return false;
      if (strictEnergy && t.energy === "low" && f.energy === "high") return false; // 高能時段留給深度工作
      return true;
    };
    const slot = free.find(f => fits(f, true)) ?? free.find(f => fits(f, false));
    if (!slot) {
      skipped.push({ taskId: t.id, title: t.title, reason: t.due && free.some(f => f.e - Math.max(f.s, earliest) >= dur) ? `期限 ${t.due} 前沒有空檔` : `找不到 ${dur / 60000} 分鐘的空檔（考慮拆小或延長 horizon）` });
      continue;
    }
    const s = snap(Math.max(slot.s, earliest)), e = s + dur;
    free = subtract(free, s - buf, e + buf).filter(f => f.e - f.s >= cfg.minBlockMin * 60000).sort((a, b) => a.s - b.s);
    perDay.set(slot.date, (perDay.get(slot.date) ?? 0) + 1);
    planned.set(t.id, e);
    const desc = [
      r.goal ? `🎯 目標：${r.goal.title}` : "", r.goal ? `💫 ${r.goal.affirmation}` : "",
      `${QUADRANT[r.quadrant]}｜分數 ${r.score}`, t.notes ? `\n${t.notes}` : "", `\n[manifest-todo:${t.id}]`,
    ].filter(Boolean).join("\n");
    items.push({ taskId: t.id, title: t.title, start: utcToLocalIso(s, tz), end: utcToLocalIso(e, tz), summary: `${cfg.eventPrefix} ${t.title}`, description: desc });
  }
  items.sort((a, b) => a.start.localeCompare(b.start));
  return { id: `plan-${nowMs}`, createdAt: new Date(nowMs).toISOString(), items, skipped, holidays: cfg.holidays };
}

export function formatPlan(p: Plan) {
  const byDay = new Map<string, PlanItem[]>();
  for (const it of p.items) byDay.set(it.start.slice(0, 10), [...(byDay.get(it.start.slice(0, 10)) ?? []), it]);
  const lines = [`🗓 排程提案 ${p.id}（${p.items.length} 個時段）`];
  for (const [day, its] of byDay) {
    lines.push(`${day}（${WEEK[new Date(Date.parse(day)).getUTCDay()]}${p.holidays?.includes(day) ? "・假日" : ""}）`);
    its.forEach(it => lines.push(`  ${it.start.slice(11, 16)}–${it.end.slice(11, 16)}  ${it.taskId} ${it.title}`));
  }
  if (p.skipped.length) lines.push("", "未排入：", ...p.skipped.map(s => `  ${s.taskId} ${s.title}：${s.reason}`));
  return lines.join("\n");
}

/** 把本地 "YYYY-MM-DDTHH:mm:ss" 轉成帶 offset 的 ISO，存進 task.scheduled */
export function toInstantIso(local: string, tz = TZ()) {
  return new Date(parseInstant(local, tz)!).toISOString();
}
