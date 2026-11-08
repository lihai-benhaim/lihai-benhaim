import { getPlatform, isTerminal, type Draft, type ValidationIssue } from "@studio/core";

/**
 * Everything the bot says to the owner, in one place (Hebrew).
 * Keep button titles at 20 characters or less (WhatsApp limit).
 */

const STATUS: Record<Draft["status"], string> = {
  planning: "מתכנן את התוכן",
  awaiting_assets: "מחכה לתמונות ממך",
  rendering: "מרנדר את הווידאו",
  awaiting_approval: "מחכה לאישור שלך",
  approved: "אושר",
  publishing: "מפרסם",
  published: "פורסם",
  partially_published: "פורסם חלקית",
  failed: "נכשל",
  cancelled: "בוטל",
};

export const t = {
  received: "קיבלתי! מתחיל לעבוד על זה. אחזור אליך עם תצוגה מקדימה.",
  busy: (d: Draft) => `אני עדיין עובד על "${d.plan?.title ?? d.brief.text.slice(0, 40)}" (${STATUS[d.status]}). אפשר לכתוב "חדש: ..." כדי להתחיל משהו אחר, או "בטל".`,
  needAssets: (items: string[]) => `כדי שזה ייצא טוב, אני צריך ממך:\n${items.map((i) => `• ${i}`).join("\n")}\n\nשלח לי אותן כאן בצ'אט.`,
  assetReceived: (left: number) => (left > 0 ? `קיבלתי 👍 חסרות עוד ${left}.` : "קיבלתי, יש לי כל מה שצריך. מרנדר..."),
  assetHeld: "קיבלתי את התמונה. מה הסטורי? תכתוב לי במשפט או שניים.",
  revising: "מעדכן לפי ההערות שלך...",
  publishing: "מאושר. מפרסם עכשיו...",
  stale: "הגרסה הזו כבר לא העדכנית. אשר את התצוגה המקדימה האחרונה.",
  cancelled: "בוטל. שום דבר לא פורסם.",
  nothingActive: "אין כרגע טיוטה פתוחה. תכתוב לי מה אתה רוצה לפרסם.",
  askEdit: "מה לשנות? תכתוב לי כאן.",
  failed: (d: Draft) => `משהו נכשל: ${d.error ?? "שגיאה לא ידועה"}`,
  status: (d: Draft) => `"${d.plan?.title ?? d.brief.text.slice(0, 40)}": ${STATUS[d.status]}${isTerminal(d.status) ? "" : "..."}`,
  previewCaption: (d: Draft) => `תצוגה מקדימה (גרסה ${d.revision}): ${d.plan?.title ?? ""}`,
  approveButton: "✅ לפרסם",
  editButton: "✏️ לשנות",
  cancelButton: "❌ לבטל",
  approvePrompt: "לפרסם בשמך?",
  accounts: (lines: string[]) => `החשבונות שלך:\n${lines.join("\n")}`,
};

export function statusLabel(status: Draft["status"]): string {
  return STATUS[status];
}

/** Text summary of a preview: what goes where, warnings, open questions. */
export function previewText(d: Draft, issues: ValidationIssue[], unlinked: string[]): string {
  const plan = d.plan;
  if (!plan) return "";
  const parts: string[] = [`*${plan.title}*`, plan.summary];
  for (const r of plan.renditions) {
    const name = `${getPlatform(r.platform).displayName} · ${r.format}`;
    const body = [r.caption, r.hashtags.map((h) => `#${h}`).join(" ")].filter(Boolean).join("\n");
    parts.push(`*${name}*\n${body ? truncate(body, 600) : "(בלי טקסט)"}`);
  }
  const problems = [
    ...issues.map((i) => `${i.severity === "error" ? "⛔" : "⚠️"} ${getPlatform(i.platform as never).displayName}: ${i.message}`),
    ...unlinked.map((p) => `🔗 ${p}: החשבון לא מחובר, לא יפורסם שם עד שתחבר`),
  ];
  if (problems.length) parts.push(problems.join("\n"));
  if (plan.questionsForUser.length) parts.push(`שאלות:\n${plan.questionsForUser.map((q) => `• ${q}`).join("\n")}`);
  return truncate(parts.join("\n\n"), 4000);
}

export function publishReport(d: Draft): string {
  const lines = d.publications.map((p) => {
    const name = getPlatform(p.platform).displayName;
    if (p.status === "published") return `✅ ${name}${p.url ? `: ${p.url}` : ""}${p.externalId?.startsWith("dry-run") ? " (dry run, לא פורסם באמת)" : ""}`;
    return `❌ ${name}: ${p.error ?? "נכשל"}`;
  });
  return `${statusLabel(d.status)}:\n${lines.join("\n")}`;
}

function truncate(s: string, max: number): string {
  return [...s].length > max ? `${[...s].slice(0, max - 1).join("")}…` : s;
}
