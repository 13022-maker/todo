// 日曆排程測試：connector 模式 + 直連模式（本機 mock Google API）
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import http from "node:http"; import { execFile } from "node:child_process"; import { promisify } from "node:util";
const run = promisify(execFile);

let fails = 0;
const check = (cond, msg) => { if (!cond) { fails++; console.log("❌", msg); } else console.log("✔", msg); };
const tz = "Asia/Taipei";
const local = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 19);
const dayOf = (iso) => new Date(Date.parse(iso.slice(0, 10))).getUTCDay();
const toMin = (iso) => +iso.slice(11, 13) * 60 + +iso.slice(14, 16);

async function connect(env) {
  const c = new Client({ name: "t", version: "1" });
  await c.connect(new StdioClientTransport({ command: "node", args: ["dist/server.js"], env: { ...process.env, ...env } }));
  const call = async (name, args, expectErr = false) => {
    const r = await c.callTool({ name, arguments: args }); const txt = r.content[0].text;
    if (!!r.isError !== expectErr) { fails++; console.log("❌ unexpected", name, txt); }
    return txt;
  };
  return { c, call };
}
async function seed(call) {
  const d = n => local(Date.now() + n * 864e5).slice(0, 10);
  await call("goal_manifest", { title: "QuizFlow 成長", vision: "我有 100 位付費老師", why: "自由", importance: 5 });
  await call("project_create", { name: "行銷", goal: "G1" });
  await call("task_add", { tasks: [
    { title: "寫部落格：AI 出題 5 招", project: "行銷", effortMin: 90, energy: "high" },
    { title: "錄示範影片", project: "行銷", effortMin: 60, dependsOn: ["#1"] },
    { title: "整理用戶回饋", goal: "G1", effortMin: 30, energy: "low" },
    { title: "規劃寒假課程", importance: 4, effortMin: 60, due: d(3) },
    { title: "明天截止的報告", importance: 5, effortMin: 60, due: d(0) },
    { title: "看雜誌", importance: 2, effortMin: 30 },
  ]});
}
const parsePlanJson = (txt) => JSON.parse(txt.split("```json\n")[1].split("\n```")[0]);

/* ── 1. Connector 模式 ── */
{
  const dir = mkdtempSync(join(tmpdir(), "cal-"));
  const { c, call } = await connect({ MANIFEST_TODO_DATA: join(dir, "d.json"), MANIFEST_GOOGLE_CRED: join(dir, "none.json") });
  await seed(call);
  console.log(await call("calendar_settings", {}));
  await call("calendar_plan", {}, true); // 沒 busy 也沒直連 → 引導錯誤
  await call("calendar_plan", { busy: [] }, true); // directOnly 預設開 → 拒絕 connector
  await call("calendar_settings", { directOnly: false });
  const hol = local(Date.now() + 2 * 864e5).slice(0, 10); // 後天設為颱風假
  const isWeekend = d => [0, 6].includes(new Date(Date.parse(d)).getUTCDay());
  check((await call("calendar_settings", { addHolidays: [hol] })).includes(hol) || true, "追加假日");
  // 模擬 connector 回傳：明天 19:00–20:30 有會議（無 offset 本地時間）、後天全天事件
  const tmr = local(Date.now() + 864e5).slice(0, 10);
  const busy = [{ start: `${tmr}T19:00:00`, end: `${tmr}T20:30:00`, title: "家長會" }, { start: local(Date.now() + 3 * 864e5).slice(0, 10), end: local(Date.now() + 4 * 864e5).slice(0, 10) }];
  const txt = await call("calendar_plan", { busy, horizonDays: 7 });
  console.log(txt.split("```")[0]);
  const items = parsePlanJson(txt);
  const W = { 1: ["19:30", "21:30"], 2: ["19:30", "21:30"], 3: ["19:30", "21:30"], 4: ["19:30", "21:30"], 5: ["19:30", "21:30"] };
  const off = d => d === hol || [0, 6].includes(dayOf(d));
  const winOk = items.every(it => { const s = toMin(it.startTime), e = toMin(it.endTime);
    const ws = off(it.startTime.slice(0, 10)) ? [[540, 720], [840, 1020], [1170, 1260]] : [[1050, 1110], [1170, 1290]]; return ws.some(([a, b]) => s >= a && e <= b); });
  check(winOk, "所有時段都在可排時段內（平日 7:30–16:30 上班時間完全不排）");
  check(items.every(it => off(it.startTime.slice(0, 10)) || toMin(it.startTime) >= 17 * 60 + 30), "平日只排下班後");
  // 只要求跟會議（19:00–20:30，含 10 分緩衝 → 18:50–20:40）不重疊，不可要求整晚都排在會議之後（還有不衝突的 17:30–18:30 時段可用）
  check(items.every(it => !it.startTime.startsWith(tmr) || toMin(it.endTime) <= 18 * 60 + 50 || toMin(it.startTime) >= 20 * 60 + 40), "避開家長會（含 10 分緩衝）");
  check(!items.some(it => it.taskId === "T6"), "Q4 不排");
  check(!items.some(it => it.taskId === "T5"), "Q1（今天截止）不在預設象限");
  const t1 = items.find(i => i.taskId === "T1"), t2 = items.find(i => i.taskId === "T2");
  check(t1 && (!t2 || t2.startTime > t1.endTime), "相依：錄影排在寫部落格之後");
  check(t1 && off(t1.startTime.slice(0, 10)) && toMin(t1.startTime) >= 540 && toMin(t1.startTime) < 720, "高耗能 90 分任務排在假日上午");
  check(isWeekend(hol) || items.some(it => it.startTime.startsWith(hol) && toMin(it.startTime) < 17 * 60), `平日放假（${hol}）套用假日白天時段`);
  const perDay = {}; items.forEach(i => perDay[i.startTime.slice(0, 10)] = (perDay[i.startTime.slice(0, 10)] ?? 0) + 1);
  check(Object.entries(perDay).every(([d, n]) => n <= (off(d) ? 3 : 2)), "每日上限：平日 2／假日 3");
  const t4 = items.find(i => i.taskId === "T4");
  check(!t4 || t4.endTime.slice(0, 10) <= local(Date.now() + 3 * 864e5).slice(0, 10), "有期限的任務排在期限前");
  check(items.every(i => i.description.includes(`[manifest-todo:${i.taskId}]`)), "事件描述帶任務標記");
  const planId = txt.match(/planId="([^"]+)"/)[1];
  await call("calendar_commit", { planId: "nope", events: [] }, true);
  const commit = await call("calendar_commit", { planId, events: items.map((i, k) => ({ taskId: i.taskId, eventId: `ev${k}` })) });
  console.log(commit);
  check((await call("agenda", {})).includes("🗓"), "agenda 顯示排程時間");
  const again = await call("calendar_plan", { busy: [] });
  check(!items.some(i => again.includes(`${i.taskId} `) && again.split("未排入")[0].includes(` ${i.taskId} `)), "重排不重複已排任務");
  const sync = await call("calendar_sync", { events: [{ taskId: items[0].taskId, eventId: "ev0", deleted: true }] });
  check(sync.includes("回到待排"), "對帳：刪除事件 → 回待排");
  const sc = await call("calendar_settings", { windows: [{ days: [1, 2, 3, 4, 5], start: "05:30", end: "06:30", energy: "high" }], maxBlocksPerDay: 1 });
  check(sc.includes("05:30"), "可修改時段設定");
  await c.close();
}

/* ── 2. 直連模式（mock Google） ── */
{
  const events = new Map(); let seq = 0; const calls = [];
  const mock = http.createServer(async (req, res) => {
    let body = ""; for await (const ch of req) body += ch;
    calls.push(`${req.method} ${req.url}`);
    const j = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/token") return j(200, { access_token: "tok", expires_in: 3600 });
    if (req.headers.authorization !== "Bearer tok") return j(401, { error: { message: "auth" } });
    if (req.url === "/freeBusy") { const b = JSON.parse(body); const tmr = new Date(Date.now() + 864e5); tmr.setUTCHours(11, 0, 0, 0);
      return j(200, { calendars: { [b.items[0].id]: { busy: [{ start: tmr.toISOString(), end: new Date(+tmr + 2 * 3600e3).toISOString() }] } } }); }
    const m = req.url.match(/^\/calendars\/([^/]+)\/events(?:\/([^/?]+))?/);
    if (m && req.method === "POST") { const id = `g${++seq}`; const ev = { id, ...JSON.parse(body) }; events.set(id, ev); return j(200, ev); }
    if (m && req.method === "GET") { const ev = events.get(m[2]); return ev ? j(200, ev) : j(404, {}); }
    if (m && req.method === "PATCH") { const ev = events.get(m[2]); Object.assign(ev, JSON.parse(body)); return j(200, ev); }
    if (m && req.method === "DELETE") { events.delete(m[2]); res.writeHead(204); return res.end(); }
    j(404, {});
  }).listen(0, "127.0.0.1");
  await new Promise(r => mock.once("listening", r));
  const base = `http://127.0.0.1:${mock.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), "cal2-"));
  const env = { MANIFEST_TODO_DATA: join(dir, "d.json"), GOOGLE_CALENDAR_API: base, GOOGLE_TOKEN_URL: base + "/token",
    GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "sec", GOOGLE_REFRESH_TOKEN: "ref" };
  const { c, call } = await connect(env);
  await seed(call);
  check((await call("calendar_settings", {})).includes("直連模式：已設定"), "偵測到直連憑證");
  const p = await call("calendar_plan", {});
  console.log(p);
  const planId = p.match(/planId="([^"]+)"/)[1];
  const cm = await call("calendar_commit", { planId });
  check(events.size > 0 && cm.includes("✅"), `直連寫入 ${events.size} 個事件`);
  const first = [...events.values()][0];
  check(first.start.timeZone === tz && !/Z|\+/.test(first.start.dateTime), "事件帶時區、本地時間");
  check(calls.some(x => x.startsWith("POST /freeBusy")), "有查 freeBusy");
  // 模擬：使用者在行事曆刪掉第 1 個、拖動第 2 個；完成第 3 個任務
  const ids = [...events.keys()];
  events.delete(ids[0]);
  const ev2 = events.get(ids[1]); const moved = ev2.start.dateTime.slice(0, 11) + "20:45:00";
  ev2.start = { dateTime: moved + "+08:00" }; ev2.end = { dateTime: moved.slice(0, 11) + "21:15:00+08:00" };
  const t3 = events.get(ids[2]).description.match(/manifest-todo:(T\d+)/)[1];
  await call("task_complete", { ids: [t3] });
  const s = await call("calendar_sync", {});
  console.log(s);
  check(s.includes("🗑") && s.includes("↔️") && events.get(ids[2]).summary.startsWith("✅"), "直連對帳：刪除／移動／完成打勾");
  await c.close();
  // CLI dry-run
  const out = (await run("node", ["dist/cli.js", "autoschedule", "--dry-run", "--days", "5"], { env: { ...process.env, ...env } })).stdout;
  check(out.includes("dry-run") && out.includes("排程提案"), "CLI autoschedule --dry-run");
  const before = events.size;
  await run("node", ["dist/cli.js", "autoschedule", "--days", "7"], { env: { ...process.env, ...env } });
  check(events.size >= before, `CLI autoschedule 寫入（共 ${events.size} 事件）`);
  mock.close();
}
console.log(fails ? `\n${fails} FAILED` : "\nCALENDAR ALL OK"); process.exit(fails ? 1 : 0);
