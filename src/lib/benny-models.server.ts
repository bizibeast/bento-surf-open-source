import { AsyncLocalStorage } from "node:async_hooks";
import { createServerOnlyFn } from "@tanstack/react-start";
import { isBennyEditingModel, type BennyEditingModelId } from "./benny-models";
import { hasManagedProviderBudget } from "./provider-budget.server";

let selectedModel: AsyncLocalStorage<BennyEditingModelId> | undefined;
const modelScope = createServerOnlyFn(
  () => (selectedModel ??= new AsyncLocalStorage<BennyEditingModelId>()),
);

/** Only authenticated managed handlers enter this scope. The atomic provider
 * reservation still verifies the paid contract and remaining allowance on every
 * attempt. Native tools remain available; this is never a BYOK transport. */
export function withBennyEditingModel<T>(model: string | undefined, work: () => T): T {
  if (model === undefined) return work();
  if (!isBennyEditingModel(model)) throw new Error("This editing model is unavailable.");
  if (!hasManagedProviderBudget())
    throw new Error("This editing model requires an active Creator+ allowance.");
  return modelScope().run(model, work);
}

export function selectedBennyEditingModel() {
  const model = modelScope().getStore();
  if (model && !hasManagedProviderBudget())
    throw new Error("This editing model requires an active Creator+ allowance.");
  return model;
}
