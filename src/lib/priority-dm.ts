import type { CommerceBuyerAnswer, CommerceProductSettings } from "./commerce";

export type PriorityDmPolicy = {
  freeFollowUpLimit: number;
  followUpPriceAmount: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function priorityDmPolicy(
  settings: CommerceProductSettings | null | undefined,
  productPriceAmount: number,
): PriorityDmPolicy {
  const free = Number(settings?.freeFollowUpLimit);
  const paid = Number(settings?.followUpPriceAmount);
  return {
    freeFollowUpLimit: Number.isInteger(free) && free >= 0 && free <= 100 ? free : 0,
    followUpPriceAmount:
      Number.isInteger(paid) && paid > 0 && paid <= 100_000_000
        ? paid
        : Math.max(1, Math.round(productPriceAmount)),
  };
}

export function priorityDmFollowUpAnswer(requestId: string, body: string): CommerceBuyerAnswer {
  return { question: "Priority follow-up", answer: body.trim(), priorityDmRequestId: requestId };
}

export function priorityDmFollowUpContext(answers: CommerceBuyerAnswer[]) {
  const answer = answers.find(
    (candidate) => candidate.question === "Priority follow-up" && candidate.priorityDmRequestId,
  );
  return answer && UUID.test(answer.priorityDmRequestId!) && answer.answer.trim()
    ? { requestId: answer.priorityDmRequestId!, body: answer.answer.trim() }
    : null;
}
