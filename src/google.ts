// Google Calendar 直連（選用）：用 OAuth refresh token 呼叫 REST API，無額外套件
import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_PATH, TZ } from "./domain.js";

export const CRED_PATH = process.env.MANIFEST_GOOGLE_CRED ?? path.join(path.dirname(DATA_PATH), "google.json");
const API = () => process.env.GOOGLE_CALENDAR_API ?? "https://www.googleapis.com/calendar/v3";
export const TOKEN_URL = () => process.env.GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token";
export const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
];

interface Cred { client_id: string; client_secret: string; refresh_token: string }

export async function loadCred(): Promise<Cred | null> {
  const env = process.env;
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN)
    return { client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: env.GOOGLE_REFRESH_TOKEN };
  try { const c = JSON.parse(await fs.readFile(CRED_PATH, "utf8")); return c.refresh_token ? c : null; } catch { return null; }
}
export async function saveCred(c: Cred) {
  await fs.mkdir(path.dirname(CRED_PATH), { recursive: true });
  await fs.writeFile(CRED_PATH, JSON.stringify(c, null, 2), { mode: 0o600 });
}

let cached: { token: string; exp: number } | null = null;
async function accessToken(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60000) return cached.token;
  const c = await loadCred();
  if (!c) throw new Error("尚未設定 Google 直連。執行 `npx manifest-todo auth` 或改用 Claude 的 Google Calendar connector 模式。");
  const r = await fetch(TOKEN_URL(), {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, refresh_token: c.refresh_token, grant_type: "refresh_token" }),
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`Google token 失敗：${j.error_description ?? j.error ?? r.status}（refresh token 可能失效，重跑 auth）`);
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return cached.token;
}

async function call(method: string, p: string, body?: unknown): Promise<any> {
  const r = await fetch(API() + p, {
    method, headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return null;
  const j: any = await r.json().catch(() => ({}));
  if (r.status === 404 || r.status === 410) return { __gone: true };
  if (!r.ok) throw new Error(`Google API ${method} ${p} → ${r.status} ${j.error?.message ?? ""}`);
  return j;
}

export async function isConfigured() { return !!(await loadCred()); }

export async function freeBusy(calendarIds: string[], timeMin: string, timeMax: string) {
  const j = await call("POST", "/freeBusy", { timeMin, timeMax, timeZone: TZ(), items: calendarIds.map(id => ({ id })) });
  return calendarIds.flatMap(id => (j.calendars?.[id]?.busy ?? []) as { start: string; end: string }[]);
}

export async function insertEvent(calendarId: string, ev: { summary: string; description: string; start: string; end: string; colorId?: string }) {
  const j = await call("POST", `/calendars/${encodeURIComponent(calendarId)}/events`, {
    summary: ev.summary, description: ev.description, colorId: ev.colorId,
    start: { dateTime: ev.start, timeZone: TZ() }, end: { dateTime: ev.end, timeZone: TZ() },
    reminders: { useDefault: true },
  });
  return j.id as string;
}

export async function getEvent(calendarId: string, eventId: string) {
  const j = await call("GET", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
  if (j?.__gone || j?.status === "cancelled") return null;
  return j as { summary: string; start: { dateTime?: string }; end: { dateTime?: string } };
}

export async function patchEvent(calendarId: string, eventId: string, patch: Record<string, unknown>) {
  return call("PATCH", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, patch);
}
export async function deleteEvent(calendarId: string, eventId: string) {
  return call("DELETE", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
}
