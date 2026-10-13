# Manifest Todo MCP

顯化思維 × 目標導向 × 輕重緩急 的待辦 AI 助理。MCP server，可接 Claude Desktop、Claude Code 或任何支援 MCP 的客戶端。

```
人生清單 (Life List)
   └─ 目標 Goal ── 願景／why／肯定句／期限／重要度 ── 顯化循環 1→4→2→8→5→7
        └─ 專案／里程碑 Project
             └─ 任務 Task ── 期限／預估時間／精力／相依／週期
每日：3・6・9 儀式 ─ 週期：review（5・調整）
```

## 顯化循環 1→4→2→8→5→7（3・6・9）

| 階段 | 名稱 | 做什麼 | 對應工具 |
|---|---|---|---|
| 1 | 起心 Intention | 願景（現在式）、why、肯定句、指標、期限 | `goal_manifest` |
| 4 | 藍圖 Structure | 拆 3–5 個里程碑，任務 30–120 分鐘 | `project_create`、`task_add` |
| 2 | 連結 Connect | 連結人生清單、資源、既有專案 | `life_list`、`import_taskmaster` |
| 8 | 行動 Act | 每天推進最小一步 | `agenda`、`next_action`、`task_complete` |
| 5 | 調整 Adjust | 看數據、放大／縮小／換路線 | `review`、`goal_update` |
| 7 | 收成 Harvest | 慶祝、感恩、內化，再開下一輪 | `goal_advance`、`ritual_369` |

3・6・9 是每日節奏：晨間寫肯定句 3 次＋定三件要事、午間 6 次＋檢查進度、夜間 9 次＋感恩回顧（`ritual_369`，會算連續天數）。

## 輕重緩急怎麼算

- 重要度 1–5：任務自填，否則繼承目標，皆無則 3
- 緊急度 1–5：依期限（逾期／≤1 天=5、≤3 天=4、≤7 天=3、≤14 天=2、其他=1）
- 四象限：重要≥4 且 緊急≥4 → Q1；重要≥4 → Q2；緊急≥4 → Q3；其他 Q4
- 分數 = 重要×2 + 緊急×1.5，再加減：逾期 +2、目標在 8・行動 +1、連結人生清單 +0.5、進行中 +1.5、≤15 分鐘 +0.5、精力相符 +1／低精力遇高耗能 −2、超過可用時間 −3、等待中 −3、前置未完成 −10

規則在 `src/domain.ts` 的 `scoreTasks()`，可自行調整權重。

## 工具

| 工具 | 用途 |
|---|---|
| `life_list` | 人生清單 add / list / achieve |
| `goal_manifest` | 建立顯化目標（起點 1） |
| `goal_list` / `goal_update` | 檢視（循環位置、進度、剩餘天數）／修改、暫停、達成 |
| `goal_advance` | 推進循環並記錄心得，走完 7 自動開下一輪 |
| `project_create` | 建專案／里程碑並掛目標 |
| `task_add` | 批次新增；同批相依可寫 `#1` 指向本批第 1 個 |
| `task_update` | 改狀態、欄位，附加時間戳進度筆記 |
| `task_complete` | 完成；週期任務自動重生、回報解鎖任務與目標進度 |
| `agenda` | 跨所有專案依輕重緩急列出，可依精力／可用時間／目標篩選 |
| `next_action` | 現在最該做的 1–3 件與理由 |
| `ritual_369` | 3・6・9 每日儀式 + 感恩紀錄 |
| `review` | 週／月回顧：動能、停滯、逾期、擱置的 Q2、無目標的待辦 |
| `import_taskmaster` | 匯入 claude-task-master 的 `tasks.json` |
| `calendar_settings` | 可排時段、緩衝、每日上限、象限、目標日曆 |
| `calendar_plan` | 找空檔，把 Q2 任務排成提案（尚未寫入） |
| `calendar_commit` | 確認提案，寫入 Google Calendar |
| `calendar_unschedule` | 取消排程，任務回到待排 |
| `calendar_sync` | 對帳：事件刪除／拖動／完成打勾／錯過重排 |

Prompts：`manifest`（一句渴望 → 目標 → 任務）、`daily_plan`、`weekly_review`、`schedule_week`
Resource：`manifest://dashboard`

## 安裝

```bash
npm install && npm run build
npm test   # 端對端測試
```

Claude Code：

```bash
claude mcp add manifest-todo -s user -- node /絕對路徑/manifest-todo-mcp/dist/server.js
```

Claude Desktop（`claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "manifest-todo": {
      "command": "node",
      "args": ["/絕對路徑/manifest-todo-mcp/dist/server.js"],
      "env": { "MANIFEST_TODO_DATA": "/Users/你/.manifest-todo/data.json" }
    }
  }
}
```

環境變數：`MANIFEST_TODO_DATA`（資料檔，預設 `~/.manifest-todo/data.json`）、`TZ_NAME`（預設 `Asia/Taipei`）。

## 使用範例

- 「用 manifest prompt：我想在 2027 年 7 月前讓 QuizFlow 的收入取代一份正職」
- 「我現在精力低，只有 30 分鐘，該做什麼？」→ `next_action`
- 「列出所有專案的待辦，按輕重緩急」→ `agenda`
- 「把 ~/QuizFlow/.taskmaster/tasks/tasks.json 匯入並掛到 QuizFlow 目標」

## 參考來源

| Repo | 取用的設計 |
|---|---|
| ai-claude-task-master | 相依關係、next-task 演算法、時間戳進度筆記、子任務、匯入相容 |
| todo-mcp | Zod 驗證、工具描述互相導引、錯誤訊息列出可用選項讓 AI 自我修正、軟刪除 |
| claude-todos | 使用者／AI 任務分工、保守完成規則、建議跟進（`next_action`、解鎖提示） |

新增：目標／人生清單階層、顯化循環、369 儀式、期限 × 重要度四象限評分、精力與可用時間篩選、週期任務、回顧。

## Google Calendar 自動排程

把重要不緊急（Q2）的任務排進行事曆空檔。

**排程規則（預設已依你的作息設定）**
| 日子 | 可排時段 | 每日上限 |
|---|---|---|
| 平日（07:30–16:30 上班） | 17:30–18:30（低精力）、19:30–21:30 | 2 段 |
| 週末、國定假日 | 09:00–12:00（高精力）、14:00–17:00、19:30–21:00（低精力） | 3 段 |

- 已內建台灣國定假日，平日放假會套用假日時段：
  - 2026：10/26 光復節補假、12/25 行憲紀念日
  - 2027：人事行政總處 116 年辦公日曆的 13 天平日假日，這一年沒有補班
- 颱風假或請假用 `calendar_settings(addHolidays=["2026-10-20"])` 追加；補班日用 `workdays` 設定。
- 會扣掉行事曆上的忙碌事件和已排的任務，前後各留 10 分鐘緩衝，開始時間對齊到 15 分鐘。
- 依分數由高到低放入：前置任務完成或已排在前面，才排它的後續任務；有期限的一定排在期限前。
- 高耗能任務優先放假日上午，低耗能任務不佔高精力時段。
- 事件描述帶 `[manifest-todo:T12]` 標記，對帳時用它找回對應的任務。
- `directOnly`（預設開啟）：只排進直連授權的私人帳號。這樣可以避免 Claude 的 connector（學校帳號）把個人目標寫進學校行事曆。

**模式一：Connector（需先 `calendar_settings(directOnly=false)`）**
Claude 用 Google Calendar connector 讀事件、建事件，本 server 只負責算排程。
直接說「用 schedule_week 把這週的 Q2 排進行事曆」即可。

**模式二：直連私人帳號（預設，可放 cron）**
1. 到 Google Cloud Console：
   - 啟用 Calendar API
   - 建立 OAuth 用戶端，類型選「電腦版應用程式」
2. 執行 `npx manifest-todo auth`，在瀏覽器登入 **prpispace@gmail.com**。憑證會存到 `~/.manifest-todo/google.json`（權限 600）。
3. 之後 MCP 的 `calendar_*` 工具會自動走直連，也可以用 CLI：

```bash
npx manifest-todo plan --days 7            # 只看提案
npx manifest-todo autoschedule --dry-run   # 對帳 + 提案，不寫入
npx manifest-todo autoschedule             # 對帳 + 寫入
# cron：每週日 20:00 排下週
0 20 * * 0  cd /path/manifest-todo-mcp && node dist/cli.js autoschedule --days 7 >> ~/.manifest-todo/cron.log 2>&1
```

也可以不用 google.json，改用環境變數 `GOOGLE_CLIENT_ID`／`GOOGLE_CLIENT_SECRET`／`GOOGLE_REFRESH_TOKEN`。

## 後續可擴充

- HTTP transport：讓 claude.ai 網頁版也能連
- 儲存換 SQLite（多裝置同步）
