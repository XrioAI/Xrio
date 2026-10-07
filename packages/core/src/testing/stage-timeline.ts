import { AsyncLocalStorage } from "node:async_hooks";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { ChannelListener } from "node:diagnostics_channel";

const isStage = (message: unknown): message is { stage: string } =>
  typeof message === "object" &&
  message !== null &&
  "stage" in message &&
  typeof message.stage === "string";

export const stageTimeline = (stages: ReadonlySet<string>) => {
  const scope = new AsyncLocalStorage<"recorded">();
  const timeline: string[] = [];

  const record: ChannelListener = (message) => {
    if (scope.getStore() === "recorded" && isStage(message) && stages.has(message.stage)) {
      timeline.push(message.stage);
    }
  };

  subscribe("xrio:stage", record);

  return {
    [Symbol.dispose]: () => {
      unsubscribe("xrio:stage", record);
    },
    mark: (event: string) => {
      timeline.push(event);
    },
    recording: <Result>(work: () => Result): Result => scope.run("recorded", work),
    timeline,
  };
};
