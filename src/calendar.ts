// 排程流程：直連模式的規劃、寫入、同步（MCP 工具與 CLI 共用）
import { Data, Plan, buildPlan, calSettings, toInstantIso, utcToLocalIso, TZ, CalendarSettings } from "./domain.js";
import * as g from "./google.js";

export async function planDirect(d: Data, opts: { horizonDays?: number; quadrants?: CalendarSettings["quadrants"]; limit?: number; taskIds?: string[] } = {}) {
  const cfg = calSettings(d);
  const horizon = opts.horizonDays ?? cfg.horizonDays;
  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + (horizon + 1) * 86400000).toISOString();
  const busy = await g.freeBusy([cfg.calendarId], timeMin, timeMax);
  return buildPlan(d, { ...opts, busy, horizonDays: horizon });
}

/** 寫入行事曆並記錄到任務；回傳成功/失敗明細 */
export async function commitDirect(d: Data, plan: Plan) {
  const cfg = calSettings(d);
  const lines: string[] = [];
  for (const it of plan.items) {
    const t = d.tasks.find(x => x.id === it.taskId);
    if (!t) continue;
    try {
      const eventId = await g.insertEvent(cfg.calendarId, { summary: it.summary, description: it.description, start: it.start, end: it.end, colorId: cfg.colorId });
      t.scheduled = { start: toInstantIso(it.start), end: toInstantIso(it.end), eventId, calendarId: cfg.calendarId, planId: plan.id };
      lines.push(`✅ ${it.start.slice(5, 16).replace("T", " ")} ${t.id} ${t.title}`);
    } catch (e: any) { lines.push(`❌ ${t.id} ${t.title}：${e.message}`); }
  }
  return lines;
}

/** 對帳：事件被刪 → 任務回待排；被拖動 → 更新時間；任務完成 → 標題加 ✅；錯過 → 回待排 */
export async function syncDirect(d: Data) {
  const lines: string[] = [];
  const now = Date.now();
  for (const t of d.tasks) {
    const s = t.scheduled;
    if (!s?.eventId) continue;
    const cal = s.calendarId ?? calSettings(d).calendarId;
    const ev = await g.getEvent(cal, s.eventId);
    if (!ev) { t.scheduled = undefined; lines.push(`🗑 ${t.id} ${t.title}：行事曆事件已刪除，回到待排`); continue; }
    const ns = ev.start?.dateTime, ne = ev.end?.dateTime;
    if (ns && ne && (Date.parse(ns) !== Date.parse(s.start) || Date.parse(ne) !== Date.parse(s.end))) {
      s.start = new Date(ns).toISOString(); s.end = new Date(ne).toISOString();
      lines.push(`↔️ ${t.id} ${t.title}：已移到 ${utcToLocalIso(Date.parse(ns), TZ()).slice(5, 16).replace("T", " ")}`);
    }
    if (t.status === "done") {
      if (!ev.summary.startsWith("✅")) { await g.patchEvent(cal, s.eventId, { summary: `✅ ${ev.summary}` }); lines.push(`✅ ${t.id} 行事曆標記完成`); }
      t.scheduled = undefined; // 已完成，不再追蹤
    } else if (Date.parse(s.end) < now && t.status !== "dropped") {
      lines.push(`⏰ ${t.id} ${t.title}：時段已過但未完成，回到待排`);
      await g.patchEvent(cal, s.eventId, { summary: `⏭ ${ev.summary}` }).catch(() => {});
      t.scheduled = undefined;
    }
  }
  return lines.length ? lines : ["行事曆與任務一致，無變更。"];
}
