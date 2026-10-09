import { describe, expect, it } from "vite-plus/test";

import { startDeadline } from "../../deadline.ts";
import type { ResultGuard } from "./port.ts";
import { turnstileCheckbox } from "./turnstile.ts";

interface WidgetReply {
  readonly box: {
    readonly x: number;
    readonly y: number;
    readonly width?: number;
    readonly height?: number;
  };
  readonly reachable: boolean;
  readonly solved: boolean;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly widget: string;
}

const WIDGET: WidgetReply = {
  box: { height: 65, width: 300, x: 490, y: 260 },
  reachable: true,
  solved: false,
  viewport: { height: 720, width: 1280 },
  widget: "cf-chl-widget-a1_response",
};

const answering = (reply: WidgetReply | null) => ({
  evaluateIsolated: async <Result>(
    _expression: string,
    isResult: ResultGuard<Result>,
  ): Promise<Result> => {
    const value = await Promise.resolve(reply);

    if (!isResult(value)) {
      throw new Error("The isolated evaluate returned an unexpected value.");
    }

    return value;
  },
});

const checkboxFor = async (reply: WidgetReply | null) => {
  using deadline = startDeadline(1000);

  return await turnstileCheckbox(answering(reply), deadline);
};

describe("the Turnstile checkbox", () => {
  it("sits 28 px into the widget at half its height, as a 10 px square", async () => {
    await expect(checkboxFor(WIDGET)).resolves.toStrictEqual({
      area: { height: 10, width: 10, x: 513, y: 287.5 },
      widget: "cf-chl-widget-a1_response",
    });
  });

  it.each([
    { name: "no widget", reply: null },
    { name: "a solved widget", reply: { ...WIDGET, solved: true } },
    { name: "a hidden or covered widget", reply: { ...WIDGET, reachable: false } },
    {
      name: "a checkbox above the viewport",
      reply: { ...WIDGET, box: { ...WIDGET.box, y: -30 } },
    },
    {
      name: "a checkbox below the viewport",
      reply: { ...WIDGET, viewport: { height: 290, width: 1280 } },
    },
    {
      name: "a checkbox left of the viewport",
      reply: { ...WIDGET, box: { ...WIDGET.box, x: -25 } },
    },
  ])("is absent for $name", async ({ reply }) => {
    await expect(checkboxFor(reply)).resolves.toBeUndefined();
  });

  it("rejects a reading of the wrong shape", async () => {
    await expect(checkboxFor({ ...WIDGET, box: { x: 490, y: 260 } })).rejects.toThrow(
      "The isolated evaluate returned an unexpected value.",
    );
  });
});
