#!/usr/bin/env node
// manifest-todo CLI：auth / plan / autoschedule / sync（直連 Google Calendar 用，可放 cron）
import http from "node:http";
import { createInterface } from "node:readline/promises";
import { load, mutate, formatPlan } from "./domain.js";
import * as g from "./google.js";
import { planDirect, commitDirect, syncDirect } from "./calendar.js";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] ?? "true" : undefined; };

async function auth() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const client_id = process.env.GOOGLE_CLIENT_ID ?? (await rl.question("OAuth Client ID（類型選「電腦版應用程式」）："));
  const client_secret = process.env.GOOGLE_CLIENT_SECRET ?? (await rl.question("OAuth Client Secret："));
  rl.close();
  const code: string = await new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      const c = u.searchParams.get("code"); const err = u.searchParams.get("error");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(c ? "<h2>✅ 授權完成，可以關閉此頁。</h2>" : `<h2>❌ ${err}</h2>`);
      srv.close(); c ? resolve(c) : reject(new Error(err ?? "no code"));
    }).listen(0, "127.0.0.1", () => {
      const port = (srv.address() as any).port;
      (globalThis as any).__redirect = `http://127.0.0.1:${port}`;
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.search = new URLSearchParams({
        client_id, redirect_uri: (globalThis as any).__redirect, response_type: "code",
        scope: g.SCOPES.join(" "), access_type: "offline", prompt: "consent",
      }).toString();
      console.log(`\n在瀏覽器開啟以下網址並登入要排程的 Google 帳號：\n\n${url}\n`);
    });
  });
  const r = await fetch(g.TOKEN_URL(), {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id, client_secret, redirect_uri: (globalThis as any).__redirect, grant_type: "authorization_code" }),
  });
  const j: any = await r.json();
  if (!j.refresh_token) throw new Error(`沒拿到 refresh_token：${JSON.stringify(j)}`);
  await g.saveCred({ client_id, client_secret, refresh_token: j.refresh_token });
  console.log(`✅ 已儲存到 ${g.CRED_PATH}（權限 600）。現在可用 autoschedule / sync，MCP 的 calendar_* 工具也會自動走直連。`);
}

async function main() {
  switch (cmd) {
    case "auth": return auth();
    case "plan": {
      const d = await load();
      const p = await planDirect(d, { horizonDays: flag("days") ? Number(flag("days")) : undefined });
      return console.log(formatPlan(p));
    }
    case "autoschedule": {
      const days = flag("days") ? Number(flag("days")) : undefined;
      const dry = rest.includes("--dry-run");
      await mutate(async d => {
        console.log((await syncDirect(d)).join("\n"));
        const p = await planDirect(d, { horizonDays: days });
        console.log("\n" + formatPlan(p));
        if (!dry && p.items.length) console.log("\n" + (await commitDirect(d, p)).join("\n"));
        if (dry) console.log("\n（dry-run，未寫入）");
      });
      return;
    }
    case "sync": return mutate(async d => console.log((await syncDirect(d)).join("\n")));
    default:
      console.log(`manifest-todo <command>
  auth                      Google Calendar OAuth 授權（直連模式）
  plan [--days N]           顯示排程提案（不寫入）
  autoschedule [--days N] [--dry-run]
                            對帳 → 排 Q2 任務 → 寫入行事曆（適合 cron）
  sync                      對帳行事曆與任務
MCP server 請執行 manifest-todo-mcp`);
  }
}
main().catch(e => { console.error("❌", e.message); process.exit(1); });
