import { enqueueContentDraftsReadyEmail } from "./email.server";
import { sendTelegramDraftsReady } from "./telegram.server";

export type ContentDraftsReadyInput = {
  userId: string;
  runId: string;
  draftCount: number;
  platforms: string[];
};

type NotificationDependencies = {
  email(input: ContentDraftsReadyInput): Promise<unknown>;
  telegram(input: ContentDraftsReadyInput): Promise<unknown>;
};

const defaults: NotificationDependencies = {
  email: enqueueContentDraftsReadyEmail,
  telegram: sendTelegramDraftsReady,
};

type NotificationState = "sent" | "skipped" | "failed";

function resultState(result: PromiseSettledResult<unknown>): NotificationState {
  if (result.status === "rejected") return "failed";
  return result.value == null ? "skipped" : "sent";
}

export async function notifyContentDraftsReady(
  input: ContentDraftsReadyInput,
  dependencies: NotificationDependencies = defaults,
) {
  const [email, telegram] = await Promise.allSettled([
    dependencies.email(input),
    dependencies.telegram(input),
  ]);
  if (email.status === "rejected") {
    console.warn("[content-notifications] email failed", {
      error: email.reason instanceof Error ? email.reason.message : "Unknown email error",
    });
  }
  if (telegram.status === "rejected") {
    console.warn("[content-notifications] Telegram failed", {
      error: telegram.reason instanceof Error ? telegram.reason.message : "Unknown Telegram error",
    });
  }
  return { email: resultState(email), telegram: resultState(telegram) };
}
