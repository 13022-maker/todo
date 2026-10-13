#!/usr/bin/env node
// Manifest Todo MCP：顯化思維 × 目標導向 × 輕重緩急 的待辦 AI 助理
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import {
  Data, Goal, Task, VORTEX, VORTEX_INFO, VortexStage, QUADRANT, DATA_PATH,
  load, mutate, newId, now, today, daysBetween, scoreTasks, goalProgress, nextStage,
  buildPlan, formatPlan, calSettings, toInstantIso, utcToLocalIso, TZ, DEFAULT_CAL, CalendarSettings,
} from "./domain.js";
import * as gcal from "./google.js";
import { planDirect, commitDirect, syncDirect } from "./calendar.js";

const server = new McpServer({ name: "manifest-todo", version: "0.1.0" });

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式 YYYY-MM-DD");
const lvl = z.number().int().min(1).max(5);

function findGoal(d: Data, idOrTitle: string) {
  return d.goals.find(g => g.id === idOrTitle) ?? d.goals.find(g => g.title.toLowerCase().includes(idOrTitle.toLowerCase()));
}
function findProject(d: Data, idOrName: string) {
  return d.projects.find(p => p.id === idOrName) ?? d.projects.find(p => p.name.toLowerCase() === idOrName.toLowerCase());
}
const goalNames = (d: Data) => d.goals.filter(g => g.status === "active").map(g => `${g.id} ${g.title}`).join("、") || "（尚無，先用 goal_manifest 建立）";
const projectNames = (d: Data) => d.projects.filter(p => !p.archived).map(p => `${p.id} ${p.name}`).join("、") || "（尚無）";
const stageLine = (s: VortexStage) => `【${s}・${VORTEX_INFO[s].name}】${VORTEX_INFO[s].focus}\n引導提問：${VORTEX_INFO[s].question}`;
const vortexPath = (s: VortexStage) => VORTEX.map(x => (x === s ? `[${x}]` : `${x}`)).join("→");

/* ═════════ 人生清單 ═════════ */

server.registerTool("life_list", {
  description: "人生清單（Bucket list）：add 新增、list 檢視、achieve 標記達成。目標可用 lifeItemId 連結到這裡，讓日常待辦對齊人生方向。",
  inputSchema: {
    action: z.enum(["add", "list", "achieve"]),
    title: z.string().optional().describe("add 時必填"),
    area: z.string().optional().describe("人生領域：健康/事業/財務/關係/學習/心靈/體驗/貢獻"),
    why: z.string().optional(),
    id: z.string().optional().describe("achieve 時必填"),
  },
}, async (a) => mutate(d => {
  if (a.action === "add") {
    if (!a.title) return fail("add 需要 title");
    const item = { id: newId(d, "L"), title: a.title, area: a.area ?? "未分類", why: a.why, createdAt: now() };
    d.lifeList.push(item);
    return ok(`已加入人生清單 ${item.id}「${item.title}」。下一步：用 goal_manifest 為它建立一個有期限的目標（lifeItemId=${item.id}）。`);
  }
  if (a.action === "achieve") {
    const it = d.lifeList.find(x => x.id === a.id);
    if (!it) return fail(`找不到 ${a.id}。現有：${d.lifeList.map(x => x.id).join(", ")}`);
    it.achievedAt = now();
    return ok(`🎉 人生清單達成：「${it.title}」。建議寫下感恩紀錄（ritual_369 evening 的 gratitude）。`);
  }
  const rows = d.lifeList.map(x => {
    const gs = d.goals.filter(g => g.lifeItemId === x.id);
    return `${x.achievedAt ? "✅" : "⬜"} ${x.id} [${x.area}] ${x.title}${gs.length ? ` ← 目標：${gs.map(g => `${g.id} ${g.title}`).join("、")}` : "（尚無目標）"}`;
  });
  return ok(rows.join("\n") || "人生清單是空的。用 action=add 開始寫下此生想完成的事。");
}));

/* ═════════ 目標（顯化） ═════════ */

server.registerTool("goal_manifest", {
  description: "建立一個顯化目標（循環起點 1・起心）。vision 用現在式描述已達成的畫面，affirmation 是 369 儀式要寫的肯定句。建立後通常接著用 goal_advance 進入 4・藍圖並用 task_add 拆解。",
  inputSchema: {
    title: z.string().min(2),
    vision: z.string().describe("現在式、具體感官描述，例如「我站在台上收到 100 位老師訂閱 QuizFlow 的通知」"),
    why: z.string().describe("為什麼重要（內在動機）"),
    affirmation: z.string().optional().describe("肯定句，現在式第一人稱；未填則由 vision 產生"),
    metric: z.string().optional(),
    targetDate: date.optional(),
    area: z.string().default("未分類"),
    importance: lvl.default(4),
    lifeItemId: z.string().optional(),
  },
}, async (a) => mutate(d => {
  if (a.lifeItemId && !d.lifeList.some(x => x.id === a.lifeItemId)) return fail(`人生清單沒有 ${a.lifeItemId}`);
  const g: Goal = {
    id: newId(d, "G"), title: a.title, vision: a.vision, why: a.why,
    affirmation: a.affirmation ?? `我很感恩，${a.vision}`,
    metric: a.metric, targetDate: a.targetDate, area: a.area, importance: a.importance,
    lifeItemId: a.lifeItemId, stage: 1, cycles: 0, status: "active",
    createdAt: now(), updatedAt: now(), journal: [],
  };
  d.goals.push(g);
  return ok([
    `✨ 目標 ${g.id}「${g.title}」已建立　循環 ${vortexPath(1)}`,
    `肯定句：${g.affirmation}`,
    stageLine(1),
    `回答完上面的提問後，呼叫 goal_advance(${g.id}) 進入 4・藍圖。`,
  ].join("\n"));
}));

server.registerTool("goal_list", {
  description: "列出目標：顯化循環階段、進度、期限剩餘天數、連結的人生清單。",
  inputSchema: { includeInactive: z.boolean().default(false) },
}, async ({ includeInactive }) => {
  const d = await load();
  const t = today();
  const rows = d.goals.filter(g => includeInactive || g.status === "active").map(g => {
    const p = goalProgress(d, g);
    const left = g.targetDate ? `剩 ${daysBetween(t, g.targetDate)} 天` : "無期限";
    const life = g.lifeItemId ? d.lifeList.find(x => x.id === g.lifeItemId)?.title : undefined;
    return `${g.id} ${g.title}｜${g.area}｜重要度${g.importance}｜${vortexPath(g.stage)} ${VORTEX_INFO[g.stage].name}｜進度 ${p.done}/${p.total} (${p.pct}%)｜${left}${g.status !== "active" ? `｜${g.status}` : ""}${life ? `\n   ↳ 人生清單：${life}` : ""}\n   ↳ 肯定句：${g.affirmation}`;
  });
  return ok(rows.join("\n") || "還沒有目標。用 goal_manifest 建立第一個。");
});

server.registerTool("goal_update", {
  description: "修改目標內容或狀態（active/paused/achieved/dropped）。",
  inputSchema: {
    goal: z.string().describe("目標 id 或名稱"),
    title: z.string().optional(), vision: z.string().optional(), why: z.string().optional(),
    affirmation: z.string().optional(), metric: z.string().optional(), targetDate: date.optional(),
    area: z.string().optional(), importance: lvl.optional(), lifeItemId: z.string().optional(),
    status: z.enum(["active", "paused", "achieved", "dropped"]).optional(),
  },
}, async ({ goal, ...patch }) => mutate(d => {
  const g = findGoal(d, goal);
  if (!g) return fail(`找不到目標「${goal}」。現有：${goalNames(d)}`);
  Object.assign(g, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), { updatedAt: now() });
  return ok(`已更新 ${g.id}「${g.title}」${patch.status === "achieved" ? "　🎉 恭喜顯化成真！記得寫感恩紀錄。" : ""}`);
}));

server.registerTool("goal_advance", {
  description: "把目標推進到顯化循環的下一階段 1→4→2→8→5→7→(新循環)。note 記錄本階段的回答／心得。可用 to 直接跳到指定階段。",
  inputSchema: {
    goal: z.string(),
    note: z.string().describe("本階段的回答、決定或心得"),
    to: z.union([z.literal(1), z.literal(4), z.literal(2), z.literal(8), z.literal(5), z.literal(7)]).optional(),
  },
}, async ({ goal, note, to }) => mutate(d => {
  const g = findGoal(d, goal);
  if (!g) return fail(`找不到目標「${goal}」。現有：${goalNames(d)}`);
  g.journal.push({ at: now(), stage: g.stage, note });
  let wrapped = false;
  if (to) g.stage = to; else ({ stage: g.stage, wrapped } = nextStage(g.stage));
  if (wrapped) g.cycles++;
  g.updatedAt = now();
  const tip: Partial<Record<VortexStage, string>> = {
    4: "用 project_create 建里程碑／專案，task_add 一次加入多個任務。",
    2: "用 life_list 連結人生清單；把相關既有專案用 project_create(goalId) 掛上來。",
    8: "用 agenda / next_action 每天挑任務；每天做 ritual_369。",
    5: "用 review 看數據，再用 task_update / goal_update 調整。",
    7: "把完成的里程碑記下來，寫感恩，決定是 achieved 還是開啟下一輪循環。",
  };
  return ok([
    `${g.id}「${g.title}」${wrapped ? `完成第 ${g.cycles} 輪循環 🔄 ` : ""}→ ${vortexPath(g.stage)}`,
    stageLine(g.stage),
    tip[g.stage] ? `工具建議：${tip[g.stage]}` : "",
  ].filter(Boolean).join("\n"));
}));

/* ═════════ 專案與任務 ═════════ */

server.registerTool("project_create", {
  description: "建立專案／里程碑，可掛在某個目標下。任務的重要度會繼承目標。",
  inputSchema: { name: z.string().min(2), goal: z.string().optional().describe("目標 id 或名稱"), description: z.string().optional() },
}, async (a) => mutate(d => {
  if (findProject(d, a.name)) return fail(`已有同名專案「${a.name}」`);
  let goalId: string | undefined;
  if (a.goal) { const g = findGoal(d, a.goal); if (!g) return fail(`找不到目標「${a.goal}」。現有：${goalNames(d)}`); goalId = g.id; }
  const p = { id: newId(d, "P"), name: a.name, goalId, description: a.description, archived: false, createdAt: now() };
  d.projects.push(p);
  return ok(`專案 ${p.id}「${p.name}」已建立${goalId ? `，連結目標 ${goalId}` : "（未連結目標——考慮它服務哪個目標）"}。`);
}));

const taskInput = z.object({
  title: z.string().min(3).max(140).describe("動詞開頭、具體可執行，例如「寫 QuizFlow 定價頁文案初稿」"),
  project: z.string().optional().describe("專案 id 或名稱"),
  goal: z.string().optional().describe("目標 id 或名稱（無專案時直接掛目標）"),
  notes: z.string().optional(),
  importance: lvl.optional().describe("1–5；不填則繼承目標，皆無則 3"),
  due: date.optional(),
  effortMin: z.number().int().positive().optional(),
  energy: z.enum(["low", "medium", "high"]).optional(),
  tags: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).default([]).describe("前置任務 id；同批新增可用 #序號 指向本批第 n 個（從 1 起）"),
  parent: z.string().optional(),
  recurDays: z.number().int().positive().optional().describe("完成後每 N 天重生（習慣、例行事項）"),
});

server.registerTool("task_add", {
  description: "新增一或多個任務（AI 拆解目標時一次送整批）。超過 2 小時的任務請拆小。",
  inputSchema: { tasks: z.array(taskInput).min(1).max(50) },
}, async ({ tasks }) => mutate(d => {
  const created: Task[] = [];
  const warn: string[] = [];
  for (const a of tasks) {
    let projectId: string | undefined, goalId: string | undefined;
    if (a.project) { const p = findProject(d, a.project); if (!p) return fail(`找不到專案「${a.project}」。現有：${projectNames(d)}。（此批未寫入）`); projectId = p.id; }
    if (a.goal) { const g = findGoal(d, a.goal); if (!g) return fail(`找不到目標「${a.goal}」。現有：${goalNames(d)}。（此批未寫入）`); goalId = g.id; }
    if (!projectId && !goalId) warn.push(`「${a.title}」沒有連結目標或專案`);
    if (a.effortMin && a.effortMin > 120) warn.push(`「${a.title}」預估 ${a.effortMin} 分鐘，建議拆小`);
    const t: Task = {
      id: newId(d, "T"), title: a.title, notes: a.notes, projectId, goalId, status: "todo",
      importance: a.importance, due: a.due, effortMin: a.effortMin, energy: a.energy, tags: a.tags,
      dependsOn: a.dependsOn, parentId: a.parent, recurDays: a.recurDays,
      createdAt: now(), updatedAt: now(), log: [],
    };
    created.push(t);
  }
  created.forEach(t => {
    t.dependsOn = t.dependsOn.map(x => (x.startsWith("#") ? created[Number(x.slice(1)) - 1]?.id ?? x : x));
  });
  d.tasks.push(...created);
  return ok([`已新增 ${created.length} 個任務：`, ...created.map(t => `  ${t.id} ${t.title}${t.due ? `（${t.due}）` : ""}${t.dependsOn.length ? ` ⟵ ${t.dependsOn.join(",")}` : ""}`), ...warn.map(w => `⚠️ ${w}`)].join("\n"));
}));

server.registerTool("task_update", {
  description: "更新任務：狀態（todo/doing/waiting/done/dropped）、欄位，或附加進度筆記（不覆蓋，帶時間戳）。完成請用 task_complete。",
  inputSchema: {
    id: z.string(),
    status: z.enum(["todo", "doing", "waiting", "dropped"]).optional(),
    title: z.string().optional(), notes: z.string().optional(), importance: lvl.optional(),
    due: date.optional(), effortMin: z.number().int().positive().optional(),
    energy: z.enum(["low", "medium", "high"]).optional(), tags: z.array(z.string()).optional(),
    dependsOn: z.array(z.string()).optional(), project: z.string().optional(), goal: z.string().optional(),
    log: z.string().optional().describe("附加一筆進度紀錄"),
  },
}, async ({ id, log, project, goal, ...patch }) => mutate(d => {
  const t = d.tasks.find(x => x.id === id);
  if (!t) return fail(`找不到任務 ${id}，先用 agenda 查 id。`);
  if (project) { const p = findProject(d, project); if (!p) return fail(`找不到專案「${project}」`); t.projectId = p.id; }
  if (goal) { const g = findGoal(d, goal); if (!g) return fail(`找不到目標「${goal}」`); t.goalId = g.id; }
  Object.assign(t, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), { updatedAt: now() });
  if (log) t.log.push({ at: now(), note: log });
  return ok(`已更新 ${t.id}「${t.title}」（${t.status}）`);
}));

server.registerTool("task_complete", {
  description: "完成任務。可附心得；週期任務會自動產生下一次；回報因此解鎖的任務與目標進度。",
  inputSchema: { ids: z.array(z.string()).min(1), note: z.string().optional() },
}, async ({ ids, note }) => mutate(d => {
  const lines: string[] = [];
  for (const id of ids) {
    const t = d.tasks.find(x => x.id === id);
    if (!t) { lines.push(`找不到 ${id}`); continue; }
    if (t.status === "done") { lines.push(`${id} 已是完成狀態`); continue; }
    const open = t.dependsOn.filter(dep => { const x = d.tasks.find(y => y.id === dep); return x && x.status !== "done" && x.status !== "dropped"; });
    t.status = "done"; t.completedAt = now(); t.updatedAt = now();
    if (note) t.log.push({ at: now(), note });
    lines.push(`✅ ${t.id} ${t.title}${open.length ? `（⚠️ 前置任務 ${open.join(",")} 尚未完成，確認是否要一併處理）` : ""}`);
    if (t.recurDays) {
      const nextDue = new Date(Date.parse(today()) + t.recurDays * 86400000).toISOString().slice(0, 10);
      const n: Task = { ...t, id: newId(d, "T"), status: "todo", due: nextDue, completedAt: undefined, createdAt: now(), updatedAt: now(), log: [] };
      d.tasks.push(n);
      lines.push(`   🔁 下一次 ${n.id} 於 ${nextDue}`);
    }
    const unlocked = d.tasks.filter(x => x.dependsOn.includes(t.id) && x.status === "todo" &&
      x.dependsOn.every(dep => d.tasks.find(y => y.id === dep)?.status === "done"));
    unlocked.forEach(u => lines.push(`   🔓 解鎖 ${u.id} ${u.title}`));
    const gid = t.goalId ?? d.projects.find(p => p.id === t.projectId)?.goalId;
    const g = d.goals.find(x => x.id === gid);
    if (g) { const p = goalProgress(d, g); lines.push(`   🎯 ${g.title} 進度 ${p.done}/${p.total} (${p.pct}%)`); }
  }
  return ok(lines.join("\n"));
}));

/* ═════════ 輕重緩急 ═════════ */

server.registerTool("agenda", {
  description: "跨所有專案／目標彙整待辦，依輕重緩急（Eisenhower 四象限 + 目標對齊分數）排序。可依精力、可用時間、目標篩選。",
  inputSchema: {
    energy: z.enum(["low", "medium", "high"]).optional().describe("你現在的精力"),
    availableMin: z.number().int().positive().optional().describe("目前可用分鐘數"),
    goal: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(30),
    groupBy: z.enum(["quadrant", "goal", "none"]).default("quadrant"),
  },
}, async (a) => {
  const d = await load();
  let rows = scoreTasks(d, { energy: a.energy, maxMin: a.availableMin });
  if (a.goal) { const g = findGoal(d, a.goal); if (!g) return fail(`找不到目標「${a.goal}」。現有：${goalNames(d)}`); rows = rows.filter(r => r.goal?.id === g.id); }
  rows = rows.slice(0, a.limit);
  if (!rows.length) return ok("沒有待辦。是時候用 goal_list 檢視目標、為下一階段新增任務了。");
  const fmt = (r: (typeof rows)[number]) =>
    `  ${r.blockedBy.length ? "⛔" : r.task.status === "doing" ? "▶️" : "•"} ${r.task.id} ${r.task.title}` +
    `｜分數 ${r.score}｜重${r.importance}/急${r.urgency}` +
    `${r.task.due ? `｜📅${r.task.due}` : ""}${r.task.effortMin ? `｜⏱${r.task.effortMin}m` : ""}` +
    `${r.project ? `｜📁${r.project.name}` : ""}${r.goal ? `｜🎯${r.goal.title}` : ""}` +
    `${r.blockedBy.length ? `｜等待 ${r.blockedBy.join(",")}` : ""}` +
    `${r.task.scheduled ? `｜🗓${utcToLocalIso(Date.parse(r.task.scheduled.start), TZ()).slice(5, 16).replace("T", " ")}` : ""}`;
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = a.groupBy === "quadrant" ? QUADRANT[r.quadrant] : a.groupBy === "goal" ? (r.goal ? `🎯 ${r.goal.title}` : "未連結目標") : "全部";
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const order = a.groupBy === "quadrant" ? Object.values(QUADRANT) : [...groups.keys()];
  return ok(order.filter(k => groups.has(k)).map(k => `${k}\n${groups.get(k)!.map(fmt).join("\n")}`).join("\n\n"));
});

server.registerTool("next_action", {
  description: "給出現在最該做的 1–3 件事與理由（排除被前置任務卡住的）。",
  inputSchema: {
    energy: z.enum(["low", "medium", "high"]).optional(),
    availableMin: z.number().int().positive().optional(),
    count: z.number().int().min(1).max(3).default(1),
  },
}, async (a) => {
  const d = await load();
  const rows = scoreTasks(d, { energy: a.energy, maxMin: a.availableMin }).filter(r => !r.blockedBy.length && r.task.status !== "waiting").slice(0, a.count);
  if (!rows.length) return ok("目前沒有可執行任務。");
  return ok(rows.map((r, i) => `${i + 1}. ${r.task.id} ${r.task.title}\n   ${QUADRANT[r.quadrant]}｜分數 ${r.score}\n   理由：${r.reasons.join("、") || "綜合重要度與期限"}${r.goal ? `\n   💫 記得：${r.goal.affirmation}` : ""}`).join("\n"));
});

/* ═════════ 3・6・9 每日儀式 ═════════ */

server.registerTool("ritual_369", {
  description: "3・6・9 顯化儀式：morning 寫肯定句 3 次＋定今日意圖；noon 寫 6 次＋檢查進度；evening 寫 9 次＋感恩與回顧。會記錄連續天數。",
  inputSchema: {
    slot: z.enum(["morning", "noon", "evening"]),
    goals: z.array(z.string()).optional().describe("今天聚焦的目標 id；不填取重要度最高的 3 個"),
    note: z.string().optional().describe("意圖／進度／回顧"),
    gratitude: z.array(z.string()).optional().describe("evening 的感恩事項"),
  },
}, async (a) => mutate(d => {
  const active = d.goals.filter(g => g.status === "active");
  const focus = a.goals?.length
    ? a.goals.map(x => findGoal(d, x)).filter((g): g is Goal => !!g)
    : [...active].sort((x, y) => y.importance - x.importance).slice(0, 3);
  if (!focus.length) return fail("還沒有進行中的目標，先用 goal_manifest 建立。");
  const t = today();
  d.rituals.push({ date: t, slot: a.slot, goalIds: focus.map(g => g.id), note: a.note });
  a.gratitude?.forEach(text => d.gratitude.push({ date: t, text }));

  const days = new Set(d.rituals.map(r => r.date));
  let streak = 0;
  for (let k = 0; ; k++) {
    const day = new Date(Date.parse(t) - k * 86400000).toISOString().slice(0, 10);
    if (days.has(day)) streak++; else break;
  }
  const times = { morning: 3, noon: 6, evening: 9 }[a.slot];
  const extra = {
    morning: () => { const top = scoreTasks(d).filter(r => !r.blockedBy.length).slice(0, 3); return `今日三件要事：\n${top.map(r => `  • ${r.task.id} ${r.task.title}`).join("\n") || "  （無）"}`; },
    noon: () => { const doneToday = d.tasks.filter(x => x.completedAt?.startsWith(t)).length; return `上午已完成 ${doneToday} 件。下午最重要的一件是什麼？`; },
    evening: () => { const doneToday = d.tasks.filter(x => x.completedAt?.startsWith(t)); return `今天完成 ${doneToday.length} 件：${doneToday.map(x => x.title).join("、") || "—"}\n感恩紀錄累計 ${d.gratitude.length} 則。明天的第一步是什麼？`; },
  }[a.slot]();
  return ok([
    `🌀 ${a.slot === "morning" ? "晨間 3" : a.slot === "noon" ? "午間 6" : "夜間 9"} 儀式｜連續 ${streak} 天`,
    `請將以下肯定句各寫 ${times} 次，邊寫邊感受已達成的畫面：`,
    ...focus.map(g => `  ✦ ${g.affirmation}`),
    extra,
  ].join("\n"));
}));

/* ═════════ 回顧 ═════════ */

server.registerTool("review", {
  description: "週／月回顧（5・調整階段）：完成數、各目標動能、停滯目標、逾期任務、被忽略的 Q2、儀式執行率，並給調整建議。",
  inputSchema: { days: z.number().int().min(1).max(90).default(7) },
}, async ({ days }) => {
  const d = await load();
  const t = today();
  const since = new Date(Date.parse(t) - days * 86400000).toISOString();
  const doneRecent = d.tasks.filter(x => x.completedAt && x.completedAt >= since);
  const scored = scoreTasks(d);
  const overdue = scored.filter(r => r.task.due && r.task.due < t);
  const q2 = scored.filter(r => r.quadrant === "Q2" && daysBetween(r.task.createdAt.slice(0, 10), t) > 14);
  const lines = [`📊 近 ${days} 天回顧（${t}）`, `完成任務 ${doneRecent.length} 件`, "", "各目標動能："];
  for (const g of d.goals.filter(x => x.status === "active")) {
    const pids = new Set(d.projects.filter(p => p.goalId === g.id).map(p => p.id));
    const n = doneRecent.filter(x => x.goalId === g.id || (x.projectId && pids.has(x.projectId))).length;
    const p = goalProgress(d, g);
    const late = g.targetDate && daysBetween(t, g.targetDate) < 0;
    lines.push(`  ${n === 0 ? "🟥 停滯" : n < 3 ? "🟨 緩慢" : "🟩 順暢"} ${g.title}｜本期完成 ${n}｜總進度 ${p.pct}%｜階段 ${VORTEX_INFO[g.stage].name}${late ? "｜⚠️ 已過期限" : ""}${p.total - p.done === 0 ? "｜⚠️ 沒有待辦，需要下一步" : ""}`);
  }
  const ritualDays = new Set(d.rituals.filter(r => r.date >= since.slice(0, 10)).map(r => r.date)).size;
  lines.push("", `369 儀式執行 ${ritualDays}/${days} 天`);
  if (overdue.length) lines.push("", `逾期 ${overdue.length} 件：`, ...overdue.slice(0, 10).map(r => `  ${r.task.id} ${r.task.title}（${r.task.due}）`));
  if (q2.length) lines.push("", `被擱置超過 14 天的 Q2（重要不緊急）${q2.length} 件：`, ...q2.slice(0, 10).map(r => `  ${r.task.id} ${r.task.title}`));
  const orphan = d.tasks.filter(x => x.status !== "done" && x.status !== "dropped" && !x.goalId && !d.projects.find(p => p.id === x.projectId)?.goalId);
  if (orphan.length) lines.push("", `未連結任何目標的待辦 ${orphan.length} 件——問自己：它服務誰？不服務就刪。`);
  lines.push("", "調整提問：", "  1. 停滯的目標：是範圍太大、動機變了，還是缺第一步？", "  2. 逾期任務：重排日期、拆小、還是放下（dropped）？", "  3. 下週要為哪個目標保留整塊時間做 Q2？");
  return ok(lines.join("\n"));
});

/* ═════════ 匯入 Taskmaster ═════════ */

server.registerTool("import_taskmaster", {
  description: "匯入 claude-task-master 的 .taskmaster/tasks/tasks.json，變成一個專案（保留相依關係、優先度、子任務），並可掛到目標下。",
  inputSchema: {
    path: z.string().describe("tasks.json 絕對路徑"),
    projectName: z.string(),
    goal: z.string().optional(),
    tag: z.string().default("master"),
  },
}, async (a) => {
  let raw: any;
  try { raw = JSON.parse(await fs.readFile(a.path, "utf8")); } catch (e: any) { return fail(`讀不到 ${a.path}：${e.message}`); }
  const list: any[] = raw?.[a.tag]?.tasks ?? raw?.tasks;
  if (!Array.isArray(list)) return fail(`檔案中找不到 tag「${a.tag}」的 tasks。可用 tag：${Object.keys(raw ?? {}).join(", ")}`);
  return mutate(d => {
    let goalId: string | undefined;
    if (a.goal) { const g = findGoal(d, a.goal); if (!g) return fail(`找不到目標「${a.goal}」`); goalId = g.id; }
    const proj = { id: newId(d, "P"), name: a.projectName, goalId, archived: false, createdAt: now(), source: `taskmaster:${a.path}#${a.tag}` };
    d.projects.push(proj);
    const pri: Record<string, number> = { critical: 5, high: 4, medium: 3, low: 2 };
    const st = (s: string): Task["status"] => s === "done" || s === "completed" ? "done" : s === "in-progress" ? "doing" : s === "blocked" || s === "review" ? "waiting" : s === "cancelled" ? "dropped" : "todo";
    const idMap = new Map<string, string>();
    const made: { t: Task; deps: string[]; scope: string }[] = [];
    const mk = (x: any, key: string, deps: any[], parentId?: string, scope = "", inherit?: number) => {
      const t: Task = {
        id: newId(d, "T"), title: String(x.title).slice(0, 140), notes: [x.description, x.details].filter(Boolean).join("\n\n") || undefined,
        projectId: proj.id, status: st(x.status ?? "pending"), importance: pri[x.priority] ?? inherit,
        tags: ["taskmaster"], dependsOn: [], parentId, createdAt: now(), updatedAt: now(), log: [],
      };
      idMap.set(key, t.id);
      made.push({ t, deps: (deps ?? []).map(String), scope });
      return t;
    };
    for (const x of list) {
      const parent = mk(x, String(x.id), x.dependencies);
      for (const s of x.subtasks ?? []) mk(s, `${x.id}.${s.id}`, s.dependencies, parent.id, String(x.id), parent.importance);
    }
    for (const { t, deps, scope } of made) {
      t.dependsOn = deps.map(k => idMap.get(k.includes(".") || !scope ? k : `${scope}.${k}`) ?? idMap.get(k)).filter((v): v is string => !!v);
    }
    d.tasks.push(...made.map(m => m.t));
    return ok(`已從 Taskmaster 匯入 ${made.length} 個任務到專案 ${proj.id}「${proj.name}」${goalId ? `（目標 ${goalId}）` : ""}。用 agenda 查看排序結果。`);
  });
});


/* ═════════ Google Calendar 自動排程 ═════════ */

const windowSchema = z.object({
  days: z.array(z.number().int().min(0).max(6)).describe("0=週日 … 6=週六"),
  start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/),
  energy: z.enum(["low", "medium", "high"]).optional(),
});
const quadrantsSchema = z.array(z.enum(["Q1", "Q2", "Q3", "Q4"]));

server.registerTool("calendar_settings", {
  description: "檢視／設定自動排程規則：可排時段（避開上課、通勤）、緩衝、每日上限、預設時長、排程範圍、要排哪些象限、目標日曆。不帶參數＝檢視；reset=true 回到預設。",
  inputSchema: {
    windows: z.array(windowSchema).optional(),
    bufferMin: z.number().int().min(0).max(60).optional(),
    maxBlocksPerDay: z.number().int().min(1).max(10).optional(),
    defaultEffortMin: z.number().int().min(15).max(240).optional(),
    minBlockMin: z.number().int().min(10).max(120).optional(),
    horizonDays: z.number().int().min(1).max(28).optional(),
    quadrants: quadrantsSchema.optional(),
    calendarId: z.string().optional(), eventPrefix: z.string().optional(), colorId: z.string().optional(),
    allDayBusy: z.boolean().optional().describe("全天事件是否視為整天忙碌"),
    snapMin: z.number().int().min(1).max(60).optional().describe("開始時間對齊（分鐘）"),
    maxBlocksOffDay: z.number().int().min(1).max(10).optional().describe("週末／國定假日每日上限"),
    holidays: z.array(date).optional().describe("平日放假日（覆寫整個清單）"),
    addHolidays: z.array(date).optional().describe("追加放假日（例如颱風假、請假、補休）"),
    workdays: z.array(date).optional().describe("週末補班日"),
    directOnly: z.boolean().optional().describe("true＝只用直連帳號排程，拒絕 connector 寫入"),
    reset: z.boolean().optional(),
  },
}, async ({ reset, addHolidays, ...patch }) => mutate(async d => {
  d.settings ??= {};
  if (reset) d.settings.calendar = {};
  if (addHolidays?.length) patch.holidays = [...new Set([...(patch.holidays ?? calSettings(d).holidays), ...addHolidays])].sort();
  d.settings.calendar = { ...(d.settings.calendar ?? {}), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Partial<CalendarSettings>;
  const c = calSettings(d);
  const W = "日一二三四五六";
  return ok([
    `排程設定（時區 ${TZ()}，直連模式：${(await gcal.isConfigured()) ? "已設定" : "未設定，使用 connector 模式"}）`,
    "可排時段：", ...c.windows.map(w => `  週${w.days.map(x => W[x]).join("")} ${w.start}–${w.end}${w.energy ? `（精力 ${w.energy}）` : ""}`),
    `國定假日（套用週末時段）${c.holidays.filter(h => h >= today()).length} 天，最近：${c.holidays.filter(h => h >= today()).slice(0, 4).join("、") || "—"}${c.workdays.length ? `｜補班 ${c.workdays.join("、")}` : ""}`,
    `${c.directOnly ? "🔒 只用直連帳號排程（私人行事曆）" : "可用 connector 或直連"}`,
    `緩衝 ${c.bufferMin} 分｜每日最多 平日 ${c.maxBlocksPerDay}／假日 ${c.maxBlocksOffDay} 段｜未估時任務 ${c.defaultEffortMin} 分｜最短空檔 ${c.minBlockMin} 分`,
    `排程範圍 ${c.horizonDays} 天｜象限 ${c.quadrants.join(",")}｜日曆 ${c.calendarId}｜標題前綴 ${c.eventPrefix}`,
  ].join("\n"));
}));

server.registerTool("calendar_plan", {
  description: [
    "把重要不緊急（預設 Q2）任務排進行事曆空檔，產生排程提案（尚未寫入）。",
    "Connector 模式：先用 Google Calendar 的 list_events 取得 horizon 內所有忙碌事件，傳入 busy（start/end 用事件原本的時間字串；全天事件可傳日期）。",
    "直連模式（已執行 auth）：busy 省略即自動查 freeBusy。",
    "提案依分數排序、遵守相依順序與期限、高耗能任務優先放高精力時段、每天不超過上限。之後用 calendar_commit 寫入。",
  ].join(" "),
  inputSchema: {
    busy: z.array(z.object({ start: z.string(), end: z.string(), title: z.string().optional() })).optional(),
    horizonDays: z.number().int().min(1).max(28).optional(),
    quadrants: quadrantsSchema.optional(),
    taskIds: z.array(z.string()).optional().describe("只排這些任務（忽略象限篩選）"),
    limit: z.number().int().min(1).max(50).default(20),
  },
}, async (a) => mutate(async d => {
  let plan;
  if (a.busy && calSettings(d).directOnly)
    return fail("目前設定只排進直連的私人帳號（directOnly）。Claude 的 Google Calendar connector 連的是其他帳號，請不要傳 busy；在本機執行 `npx manifest-todo auth` 用私人帳號授權後再呼叫。若確定要用 connector 帳號，先 calendar_settings(directOnly=false)。");
  if (a.busy) plan = buildPlan(d, { ...a, busy: a.busy });
  else if (await gcal.isConfigured()) {
    try { plan = await planDirect(d, a); } catch (e: any) { return fail(e.message); }
  } else return fail("需要忙碌時段：請先用 Google Calendar connector 的 list_events 查詢排程範圍內的事件，把每個事件的 start/end 傳進 busy（沒有事件就傳 []）。或在本機執行 `npx manifest-todo auth` 啟用直連模式。");
  d.pendingPlan = plan;
  const direct = !a.busy;
  const forConnector = plan.items.map(it => ({ taskId: it.taskId, summary: it.summary, startTime: it.start, endTime: it.end, description: it.description }));
  return ok([
    formatPlan(plan), "",
    plan.items.length === 0 ? "沒有可排的任務或空檔。" :
      direct ? `確認後呼叫 calendar_commit(planId="${plan.id}") 直接寫入 Google Calendar。`
             : `確認後：對每一筆用 Google Calendar create_event 建立事件（summary/startTime/endTime/description 照下方，colorId=${calSettings(d).colorId ?? "不指定"}），再把各自的 eventId 傳給 calendar_commit(planId="${plan.id}", events=[{taskId,eventId}])。`,
    plan.items.length && !direct ? "```json\n" + JSON.stringify(forConnector, null, 1) + "\n```" : "",
  ].filter(Boolean).join("\n"));
}));

server.registerTool("calendar_commit", {
  description: "確認排程提案。Connector 模式：傳入 events（每筆 taskId + 建好的 eventId，可只傳部分＝只採用部分）。直連模式：省略 events 即由本 server 直接建立 Google Calendar 事件。",
  inputSchema: {
    planId: z.string(),
    events: z.array(z.object({ taskId: z.string(), eventId: z.string().optional(), calendarId: z.string().optional() })).optional(),
  },
}, async ({ planId, events }) => mutate(async d => {
  const plan = d.pendingPlan;
  if (!plan || plan.id !== planId) return fail(`找不到提案 ${planId}（可能已確認或被新的 calendar_plan 取代），請重新 calendar_plan。`);
  let lines: string[];
  if (events && calSettings(d).directOnly) return fail("directOnly 已開啟：請省略 events，由直連帳號建立事件。");
  if (events) {
    lines = [];
    for (const e of events) {
      const it = plan.items.find(x => x.taskId === e.taskId); const t = d.tasks.find(x => x.id === e.taskId);
      if (!it || !t) { lines.push(`⚠️ ${e.taskId} 不在提案中`); continue; }
      t.scheduled = { start: toInstantIso(it.start), end: toInstantIso(it.end), eventId: e.eventId, calendarId: e.calendarId ?? calSettings(d).calendarId, planId };
      lines.push(`✅ ${it.start.slice(5, 16).replace("T", " ")} ${t.id} ${t.title}`);
    }
  } else {
    if (!(await gcal.isConfigured())) return fail("直連模式未設定，請傳入 events（connector 建立的 eventId）。");
    lines = await commitDirect(d, plan);
  }
  d.pendingPlan = undefined;
  return ok([`已排入行事曆 ${lines.filter(l => l.startsWith("✅")).length} 段：`, ...lines, "", "之後執行 calendar_sync（直連）或在完成任務後於行事曆打勾。"].join("\n"));
}));

server.registerTool("calendar_unschedule", {
  description: "取消任務的排程（任務回到待排）。直連模式且 deleteEvent=true 時同時刪除行事曆事件；connector 模式請自行用 delete_event 刪除，本工具回傳 eventId。",
  inputSchema: { taskIds: z.array(z.string()).min(1), deleteEvent: z.boolean().default(false) },
}, async ({ taskIds, deleteEvent }) => mutate(async d => {
  const lines: string[] = [];
  const direct = await gcal.isConfigured();
  for (const id of taskIds) {
    const t = d.tasks.find(x => x.id === id);
    if (!t?.scheduled) { lines.push(`${id} 沒有排程`); continue; }
    const { eventId, calendarId } = t.scheduled;
    if (deleteEvent && eventId && direct) { try { await gcal.deleteEvent(calendarId ?? "primary", eventId); } catch (e: any) { lines.push(`⚠️ ${id} 刪除事件失敗：${e.message}`); } }
    t.scheduled = undefined;
    lines.push(`↩️ ${id} ${t.title} 回到待排${eventId && !(deleteEvent && direct) ? `（行事曆事件 ${eventId} 仍在）` : ""}`);
  }
  return ok(lines.join("\n"));
}));

server.registerTool("calendar_sync", {
  description: "對帳行事曆與任務：事件被刪→回待排、被拖動→更新時間、任務已完成→事件標題加 ✅、時段已過未完成→回待排（可再 calendar_plan）。直連模式自動查；connector 模式傳入 events（用 list_events 查到、描述含 [manifest-todo:ID] 的事件）。",
  inputSchema: {
    events: z.array(z.object({ taskId: z.string(), eventId: z.string(), start: z.string().optional(), end: z.string().optional(), deleted: z.boolean().optional() })).optional(),
  },
}, async ({ events }) => mutate(async d => {
  if (!events) {
    if (!(await gcal.isConfigured())) return fail("connector 模式：請用 list_events 查詢已排的事件（描述含 [manifest-todo:Txx]），將 taskId/eventId/start/end 傳入 events；沒查到的事件請標 deleted=true。");
    try { return ok((await syncDirect(d)).join("\n")); } catch (e: any) { return fail(e.message); }
  }
  const lines: string[] = []; const nowMs = Date.now(); const toMark: string[] = [];
  for (const e of events) {
    const t = d.tasks.find(x => x.id === e.taskId);
    if (!t?.scheduled) continue;
    if (e.deleted) { t.scheduled = undefined; lines.push(`🗑 ${t.id} 事件已刪，回到待排`); continue; }
    if (e.start && e.end) { t.scheduled.start = toInstantIso(e.start); t.scheduled.end = toInstantIso(e.end); }
    if (t.status === "done") { toMark.push(`${e.eventId}（${t.title}）`); t.scheduled = undefined; }
    else if (Date.parse(t.scheduled.end) < nowMs) { t.scheduled = undefined; lines.push(`⏰ ${t.id} ${t.title} 時段已過未完成，回到待排`); }
  }
  if (toMark.length) lines.push(`請用 update_event 把以下事件標題前加 ✅：${toMark.join("、")}`);
  return ok(lines.join("\n") || "一致，無變更。");
}));

/* ═════════ Resource：總覽 ═════════ */

server.registerResource("dashboard", "manifest://dashboard", {
  title: "顯化總覽", description: "人生清單、目標循環、今日前 5 要事", mimeType: "text/markdown",
}, async (uri) => {
  const d = await load();
  const top = scoreTasks(d).filter(r => !r.blockedBy.length).slice(0, 5);
  const md = [
    `# 顯化總覽 ${today()}`, `資料檔：${DATA_PATH}`, "", "## 目標",
    ...d.goals.filter(g => g.status === "active").map(g => { const p = goalProgress(d, g); return `- **${g.title}**　${vortexPath(g.stage)}　${p.pct}%　_${g.affirmation}_`; }),
    "", "## 今日要事", ...top.map(r => `- [${r.quadrant}] ${r.task.id} ${r.task.title}`),
    "", "## 人生清單", ...d.lifeList.map(x => `- ${x.achievedAt ? "✅" : "⬜"} ${x.title}`),
  ].join("\n");
  return { contents: [{ uri: uri.href, text: md, mimeType: "text/markdown" }] };
});

/* ═════════ Prompts：引導流程 ═════════ */

server.registerPrompt("manifest", {
  title: "顯化一個願望", description: "把模糊的渴望，走完 1・起心→4・藍圖→2・連結，變成可執行任務",
  argsSchema: { desire: z.string().describe("你想要的東西，越真實越好") },
}, ({ desire }) => ({
  messages: [{ role: "user", content: { type: "text", text:
`我想要：${desire}

請當我的顯化教練兼專案經理，依序進行，每一步先問我、等我回答再往下：
1・起心：協助我把它寫成現在式的願景畫面、內在動機 why、一句肯定句、可衡量指標與期限。確認後呼叫 goal_manifest。
4・藍圖：拆 3–5 個里程碑（project_create），每個里程碑拆成 30–120 分鐘、動詞開頭的任務，標出相依關係、預估時間與精力，一次用 task_add 送出。呼叫 goal_advance 記錄。
2・連結：先 life_list list，問我這個目標服務哪個人生清單項目（沒有就新增）；問我已有哪些資源／人可以幫忙。呼叫 goal_advance 進入 8・行動。
最後用 next_action 告訴我今天的第一步。` } }],
}));

server.registerPrompt("daily_plan", {
  title: "今日規劃", description: "晨間 3 儀式 + 依輕重緩急排出今天",
  argsSchema: { energy: z.string().optional().describe("low/medium/high"), hours: z.string().optional().describe("今天可用小時數") },
}, ({ energy, hours }) => ({
  messages: [{ role: "user", content: { type: "text", text:
`幫我規劃今天。我的精力：${energy ?? "未說明"}，可用時間：${hours ?? "未說明"} 小時。
1. 呼叫 ritual_369(slot="morning")，帶我寫肯定句。
2. 呼叫 agenda（帶入精力與時間），挑出：1 件 Q1、至少 1 件 Q2（推進目標的深度工作）、快速處理的 Q3；Q4 建議刪除。
3. 排成時段表，總時數不超過可用時間的 80%，深度工作放在精力最好的時段。
4. 結尾給我一句今天的意圖。用繁體中文，簡潔。` } }],
}));

server.registerPrompt("weekly_review", {
  title: "週回顧", description: "5・調整：檢視數據、調整範圍、規劃下週 Q2",
}, () => ({
  messages: [{ role: "user", content: { type: "text", text:
`帶我做週回顧：
1. 呼叫 review(days=7) 與 goal_list。
2. 針對停滯目標逐一問我原因，給出「放大／縮小／換路線／暫停」建議，經我同意後用 goal_update / task_update / task_add 調整。
3. 逾期任務逐件決定：重排、拆小或 dropped。
4. 為下週每個主要目標安排至少一段 Q2 時間；符合 7・收成 的目標，引導我寫感恩與心得並 goal_advance。
5. 結束時呼叫 ritual_369(slot="evening")。` } }],
}));

server.registerPrompt("schedule_week", {
  title: "把 Q2 排進行事曆", description: "用 Google Calendar connector 找空檔，自動排入重要不緊急的任務",
  argsSchema: { days: z.string().optional().describe("排幾天，預設 7") },
}, ({ days }) => ({
  messages: [{ role: "user", content: { type: "text", text:
`把我重要但不緊急的任務排進行事曆空檔，範圍 ${days ?? "7"} 天：
1. calendar_settings 檢視設定。
2. 若顯示「只用直連帳號排程」：呼叫 calendar_sync 對帳，再呼叫 calendar_plan(horizonDays=${days ?? "7"})（不要傳 busy）。若回報直連未設定，告訴我在本機執行 npx manifest-todo auth，然後停止。
   若允許 connector：用 Google Calendar list_events 查從現在起 ${days ?? "7"} 天的事件（orderBy=startTime，pageSize=250），把每個事件 start/end 傳入 calendar_plan 的 busy。
3. 把提案用表格給我看，等我確認或調整（可用 taskIds 指定、calendar_settings 改時段後重排）。
4. 我確認後呼叫 calendar_commit（直連省略 events；connector 模式先逐筆 create_event 再傳 eventId）。
5. 最後列出排好的時段。用繁體中文，簡潔。` } }],
}));

await server.connect(new StdioServerTransport());
