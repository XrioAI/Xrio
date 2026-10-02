export const isLaunchEvent = (
  message: unknown,
): message is { event: "browser-launched"; detail: string } =>
  typeof message === "object" &&
  message !== null &&
  "event" in message &&
  message.event === "browser-launched" &&
  "detail" in message &&
  typeof message.detail === "string";
