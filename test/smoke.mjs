import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os"; import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "mt-"));
const c = new Client({ name: "smoke", version: "1" });
await c.connect(new StdioClientTransport({ command: "node", args: ["dist/server.js"], env: { ...process.env, MANIFEST_TODO_DATA: join(dir, "d.json") } }));
let fails = 0;
fails++; console.log("❌ 測試用：故意製造失敗，驗證 branch protection 是否擋得住");
const call = async (name, args, expectErr = false) => {
  const r = await c.callTool({ name, arguments: args });
  const txt = r.content[0].text;
  if (!!r.isError !== expectErr) { fails++; console.log("❌", name, txt); } else console.log(`── ${name}\n${txt}\n`);
  return txt;
};
const d = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
console.log("tools:", (await c.listTools()).tools.map(t => t.name).join(", "));
await call("life_list", { action: "add", title: "財務自由後半退休", area: "財務" });
await call("goal_manifest", { title: "QuizFlow 100 付費老師", vision: "我收到第 100 位老師訂閱的通知", why: "讓我能自由選擇工作", targetDate: d(60), area: "事業", importance: 5, lifeItemId: "L1" });
await call("goal_advance", { goal: "G1", note: "畫面清楚" });
await call("project_create", { name: "行銷", goal: "QuizFlow" });
await call("task_add", { tasks: [
  { title: "寫定價頁文案", project: "行銷", due: d(1), effortMin: 60, energy: "high" },
  { title: "發布到教師社群", project: "行銷", dependsOn: ["#1"], effortMin: 15 },
  { title: "整理抽屜", importance: 1 },
  { title: "每日 15 分鐘回覆用戶", goal: "G1", recurDays: 1, effortMin: 15 },
]});
await call("task_add", { tasks: [{ title: "xxx 測試", project: "不存在" }] }, true);
await call("agenda", {});
await call("next_action", { energy: "low", count: 2 });
await call("task_complete", { ids: ["T4", "T7"], note: "完成" });
await call("ritual_369", { slot: "morning" });
await call("ritual_369", { slot: "evening", gratitude: ["學生的回饋"] });
const tm = join(dir, "tasks.json");
writeFileSync(tm, JSON.stringify({ master: { tasks: [
  { id: 1, title: "Setup repo", status: "done", priority: "high", dependencies: [] },
  { id: 2, title: "Build API", status: "pending", priority: "medium", dependencies: [1], subtasks: [{ id: 1, title: "Routes", status: "pending", dependencies: [] }, { id: 2, title: "Tests", dependencies: [1] }] },
]}}));
await call("import_taskmaster", { path: tm, projectName: "QuizFlow dev", goal: "G1" });
await call("agenda", { groupBy: "goal", limit: 20 });
await call("review", { days: 7 });
await call("goal_list", {});
const res = await c.readResource({ uri: "manifest://dashboard" }); console.log(res.contents[0].text);
console.log("prompts:", (await c.listPrompts()).prompts.map(p => p.name).join(", "));
await c.close();
console.log(fails ? `\n${fails} FAILED` : "\nALL OK"); process.exit(fails ? 1 : 0);
