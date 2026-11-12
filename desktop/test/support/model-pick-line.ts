// For fakes standing in for main's model-pick handler (src/main/ipc.ts
// IPC.modelPick; model-pick-main.test.ts runs the real one): the line main makes of a listed pick (as
// src/shared/model-choices.ts modelPickCommand makes it) and the guards it sends it with (ipc.ts pickBinding).

import type { PickRequest } from "../../src/renderer/components/agent-picks";
import type { ModelPick } from "../../src/shared/model-choices";
import type { SendBinding } from "../../src/shared/send-binding";

/** Main's line for a listed pick. */
export const pickLine = (pick: ModelPick): string => (pick.effort === null ? `/model ${pick.model}` : `/model ${pick.model} --reasoning=${pick.effort}`);

/** A pick's binding as main sends it: at the prompt only, never queued. */
export function mainPickBinding(binding: SendBinding): SendBinding {
  const { queuesWhileWorking: _queues, ...rest } = binding;
  return { ...rest, atPromptOnly: true };
}

/** A chip's pick naming a model, as AgentChips.tsx makes it (the structured pick, its line to show and copy). */
export function namedPick(kind: "model" | "effort", modelPick: ModelPick, label: string): PickRequest {
  return { kind, value: kind === "model" ? modelPick.model : (modelPick.effort ?? ""), label, command: pickLine(modelPick), modelPick };
}
