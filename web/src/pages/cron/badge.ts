import { json } from "@/lib/api";
import { ui } from "@/stores/app";

export async function refreshCronBadge() {
  try {
    const result = await json("/v1/cron/reports?limit=1");
    ui.cronUnread = result.unreadCount ?? 0;
  } catch {}
}
