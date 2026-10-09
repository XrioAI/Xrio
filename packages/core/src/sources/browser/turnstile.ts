import type { Deadline } from "../../deadline.ts";
import type { ChallengeCheckbox } from "./challenge.ts";
import type { DriverBrowser, PageArea } from "./port.ts";

const WIDGET_MIN_WIDTH_PX = 200;

const WIDGET_MIN_HEIGHT_PX = 40;

const CHECKBOX_INSET_PX = 28;

const CHECKBOX_REACH_PX = 5;

const WIDGET_READ = `(() => {
  const field = document.querySelector('input[name="cf-turnstile-response"]');
  let host = field?.parentElement ?? null;

  while (host !== null) {
    const { width, height } = host.getBoundingClientRect();

    if (width >= ${WIDGET_MIN_WIDTH_PX} && height >= ${WIDGET_MIN_HEIGHT_PX}) {
      break;
    }

    host = host.parentElement;
  }

  if (field === null || host === null) {
    return null;
  }

  const box = host.getBoundingClientRect();
  const hit = document.elementFromPoint(box.left + ${CHECKBOX_INSET_PX}, box.top + box.height / 2);
  const shown = host.checkVisibility({ opacityProperty: true, visibilityProperty: true });

  return {
    box: { height: box.height, width: box.width, x: box.left, y: box.top },
    reachable: shown && hit !== null && host.contains(hit),
    solved: field.value !== "",
    viewport: { height: innerHeight, width: innerWidth },
    widget: field.id,
  };
})()`;

interface Viewport {
  readonly width: number;
  readonly height: number;
}

interface WidgetReading {
  readonly box: PageArea;
  readonly reachable: boolean;
  readonly solved: boolean;
  readonly viewport: Viewport;
  readonly widget: string;
}

const isViewport = (value: unknown): value is Viewport =>
  typeof value === "object" &&
  value !== null &&
  "width" in value &&
  typeof value.width === "number" &&
  "height" in value &&
  typeof value.height === "number";

const isArea = (value: unknown): value is PageArea =>
  isViewport(value) &&
  "x" in value &&
  typeof value.x === "number" &&
  "y" in value &&
  typeof value.y === "number";

const isWidgetReading = (value: unknown): value is WidgetReading =>
  typeof value === "object" &&
  value !== null &&
  "box" in value &&
  isArea(value.box) &&
  "reachable" in value &&
  typeof value.reachable === "boolean" &&
  "solved" in value &&
  typeof value.solved === "boolean" &&
  "viewport" in value &&
  isViewport(value.viewport) &&
  "widget" in value &&
  typeof value.widget === "string";

const isWidgetReply = (value: unknown): value is WidgetReading | null =>
  value === null || isWidgetReading(value);

const checkboxIn = (box: PageArea): PageArea => ({
  height: 2 * CHECKBOX_REACH_PX,
  width: 2 * CHECKBOX_REACH_PX,
  x: box.x + CHECKBOX_INSET_PX - CHECKBOX_REACH_PX,
  y: box.y + box.height / 2 - CHECKBOX_REACH_PX,
});

const isOnScreen = (area: PageArea, viewport: Viewport): boolean =>
  area.x >= 0 &&
  area.y >= 0 &&
  area.x + area.width <= viewport.width &&
  area.y + area.height <= viewport.height;

export const turnstileCheckbox = async (
  browser: Pick<DriverBrowser, "evaluateIsolated">,
  deadline: Deadline,
): Promise<ChallengeCheckbox | undefined> => {
  const reading = await browser.evaluateIsolated(WIDGET_READ, isWidgetReply, deadline);

  if (reading === null || reading.solved || !reading.reachable) {
    return undefined;
  }

  const area = checkboxIn(reading.box);

  return isOnScreen(area, reading.viewport) ? { area, widget: reading.widget } : undefined;
};
