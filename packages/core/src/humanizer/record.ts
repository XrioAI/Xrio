import type { DeviceRecord, Observation, PresentedDevice, TimezonePolicy } from "./contracts.ts";
import type { SurfaceChoices } from "./surfaces.ts";

const timezonePolicyOf = ({ source, zone }: SurfaceChoices["timezone"]): TimezonePolicy => {
  switch (source) {
    case "pin": {
      return { kind: "pinned", zone };
    }

    case "exit": {
      return { kind: "exit" };
    }

    case "host": {
      return { kind: "host", zone };
    }

    default: {
      throw new Error(`No policy for ${JSON.stringify(source satisfies never)}.`);
    }
  }
};

export const voicesOf = ({
  persona,
}: SurfaceChoices["speech"]): DeviceRecord["device"]["voices"] =>
  persona === null ? { kind: "system" } : { kind: "persona", name: persona };

export const fontsOf = ({ fonts }: SurfaceChoices): DeviceRecord["device"]["fonts"] =>
  fonts.source === "package" ? { digest: fonts.payload, kind: "stack" } : { kind: "system" };

export const recordOf = (
  seed: DeviceRecord["seed"],
  { screen, window }: Pick<PresentedDevice, "screen" | "window">,
  surfaces: SurfaceChoices,
): DeviceRecord => ({
  device: {
    cores: 0,
    fonts: fontsOf(surfaces),
    gpu: structuredClone(surfaces.gpu),
    memoryGb: 0,
    screen: structuredClone(screen),
    voices: voicesOf(surfaces.speech),
    window: structuredClone(window),
  },
  policy: { locale: surfaces.locale.tag, timezone: timezonePolicyOf(surfaces.timezone) },
  schema: 1,
  seed,
});

const insetsWithin = ({
  availHeight,
  availLeft,
  availTop,
  availWidth,
  screenHeight,
  screenWidth,
}: Observation): PresentedDevice["screen"]["workArea"] => {
  const inside =
    availLeft >= 0 &&
    availTop >= 0 &&
    availLeft + availWidth <= screenWidth &&
    availTop + availHeight <= screenHeight;

  return inside
    ? {
        bottom: screenHeight - availTop - availHeight,
        left: availLeft,
        right: screenWidth - availLeft - availWidth,
        top: availTop,
      }
    : {
        bottom: Math.max(0, screenHeight - availHeight),
        left: 0,
        right: Math.max(0, screenWidth - availWidth),
        top: 0,
      };
};

export const presentedScreen = (observation: Observation): PresentedDevice["screen"] => ({
  height: observation.screenHeight,
  width: observation.screenWidth,
  workArea: insetsWithin(observation),
});
