import { z } from "zod";
import { ProviderError } from "./social-provider-error";

const resultSchema = z.object({ id: z.string().min(1), url: z.string().optional() });
const progressSchema = z.object({
  completed: z.array(resultSchema).max(25),
  pending: z.number().int().min(0).max(24).nullable(),
});
export type SocialPublishProgress = z.infer<typeof progressSchema>;
type Result = SocialPublishProgress["completed"][number];
type Step = (previous?: Result) => Promise<Result>;

/** A pending checkpoint is deliberately not replayable: the provider may have accepted it. */
export async function runSocialPublishSequence(
  saved: unknown,
  steps: Step[],
  checkpoint: (progress: SocialPublishProgress) => Promise<void>,
): Promise<Result> {
  let progress = saved == null ? { completed: [], pending: null } : progressSchema.parse(saved);
  const uncertain = () =>
    new ProviderError(
      `${progress.completed.length} part(s) published. The next result is unconfirmed. Check your profile before creating another post; Bento will not resend it automatically.`,
      "outcome_unknown",
      false,
    );
  if (progress.pending != null || progress.completed.length > steps.length) throw uncertain();
  for (let index = progress.completed.length; index < steps.length; index++) {
    await checkpoint({ ...progress, pending: index });
    let result: Result;
    try {
      result = await steps[index](progress.completed.at(-1));
      if (!result.id) throw uncertain();
    } catch (error) {
      // Only explicit rejections (including budget denial before fetch) prove no write occurred.
      if (
        error instanceof ProviderError &&
        (error.code === "budget_exhausted" ||
          (error.status != null &&
            error.status >= 400 &&
            error.status < 500 &&
            error.status !== 408))
      ) {
        try {
          await checkpoint({ ...progress, pending: null });
        } catch {
          throw uncertain();
        }
        throw new ProviderError(
          `${progress.completed.length} part(s) published. ${error.message}`,
          error.code,
          error.retryable,
          error.status,
          error.retryAfterSeconds,
          error.providerCode,
        );
      }
      throw uncertain();
    }
    const next = { completed: [...progress.completed, result], pending: null };
    try {
      await checkpoint(next);
    } catch {
      throw uncertain();
    }
    progress = next;
  }
  if (!progress.completed[0]) throw new Error("A publish sequence needs a post.");
  return progress.completed[0];
}
