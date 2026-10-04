import { describe, expect, it } from "vite-plus/test";

import { isMinted, mergeBrowserInputs } from "./inputs.ts";
import type { LaunchInput } from "./owned-inputs.ts";
import { EMISSION_ORDER } from "./surfaces.ts";
import type { Resolution, Resolutions, SurfaceName } from "./surfaces.ts";

const isComplete = (candidate: Readonly<Record<string, Resolution>>): candidate is Resolutions =>
  EMISSION_ORDER.every((name) => name in candidate);

const resolutionsOf = (
  emitted: Partial<Record<SurfaceName, readonly LaunchInput[]>>,
): Resolutions => {
  const resolutions = Object.fromEntries(
    EMISSION_ORDER.map((name) => [name, { expected: [], inputs: emitted[name] ?? [] }]),
  );

  if (!isComplete(resolutions)) {
    throw new Error("A surface is missing from the test resolutions.");
  }

  return resolutions;
};

describe(mergeBrowserInputs, () => {
  it("puts switches in emission order whatever order the surfaces arrive in", () => {
    const { switches } = mergeBrowserInputs(
      resolutionsOf({
        gpu: [{ name: "--use-gl", sink: "switch", value: "3" }],
        leaks: [{ name: "--use-angle", sink: "switch", value: "6" }],
        locale: [{ name: "--lang", sink: "switch", value: "1" }],
        screen: [{ name: "--screen-info", sink: "switch", value: "5" }],
        timezone: [{ name: "--accept-lang", sink: "switch", value: "2" }],
        window: [{ name: "--window-size", sink: "switch", value: "4" }],
      }),
    );

    expect(switches).toStrictEqual([
      "--lang=1",
      "--accept-lang=2",
      "--use-gl=3",
      "--window-size=4",
      "--screen-info=5",
      "--use-angle=6",
    ]);
  });

  it("keeps each sink apart, nesting dotted names", () => {
    const inputs = mergeBrowserInputs(
      resolutionsOf({
        leaks: [
          { name: "net.network_prediction_options", sink: "preference", value: 2 },
          { name: "dns_over_https.mode", sink: "local-state", value: "off" },
        ],
        locale: [
          { name: "LANG", sink: "environment", value: "C.UTF-8" },
          { name: "intl.accept_languages", sink: "preference", value: "en-US,en" },
        ],
        timezone: [{ name: "TZ", sink: "forwarded-environment", value: "Asia/Kolkata" }],
      }),
    );

    expect({
      environment: inputs.environment,
      forwardedEnvironment: inputs.forwardedEnvironment,
      localState: inputs.localState,
      preferences: inputs.preferences,
      switches: inputs.switches,
    }).toStrictEqual({
      environment: { LANG: "C.UTF-8" },
      forwardedEnvironment: { TZ: "Asia/Kolkata" },
      localState: { dns_over_https: { mode: "off" } },
      preferences: {
        intl: { accept_languages: "en-US,en" },
        net: { network_prediction_options: 2 },
      },
      switches: [],
    });
  });

  it("throws when two surfaces emit one owned name", () => {
    expect(() =>
      mergeBrowserInputs(
        resolutionsOf({
          locale: [{ name: "--lang", sink: "switch", value: "en-US" }],
          window: [{ name: "--lang", sink: "switch", value: "de-DE" }],
        }),
      ),
    ).toThrow("The locale and window surfaces both emit the switch --lang.");
  });

  it("throws when one surface emits an owned name twice", () => {
    expect(() =>
      mergeBrowserInputs(
        resolutionsOf({
          timezone: [
            { name: "TZ", sink: "forwarded-environment", value: "UTC" },
            { name: "TZ", sink: "forwarded-environment", value: "Asia/Kolkata" },
          ],
        }),
      ),
    ).toThrow("The timezone and timezone surfaces both emit the forwarded-environment TZ.");
  });

  it("freezes what it mints, nested values included", () => {
    const inputs = mergeBrowserInputs(
      resolutionsOf({
        leaks: [{ name: "dns_over_https.mode", sink: "local-state", value: "off" }],
        locale: [
          { name: "--lang", sink: "switch", value: "en-US" },
          { name: "LANG", sink: "environment", value: "C.UTF-8" },
        ],
      }),
    );

    expect([
      Object.isFrozen(inputs),
      Object.isFrozen(inputs.switches),
      Object.isFrozen(inputs.environment),
      Object.isFrozen(inputs.forwardedEnvironment),
      Object.isFrozen(inputs.preferences),
      Object.isFrozen(inputs.localState),
      Object.isFrozen(inputs.localState.dns_over_https),
    ]).toStrictEqual([true, true, true, true, true, true, true]);
  });

  it("recognises what it minted and nothing copied from it", () => {
    const inputs = mergeBrowserInputs(resolutionsOf({}));

    expect([
      isMinted(inputs),
      isMinted({ ...inputs }),
      isMinted({ ...inputs, switches: [] }),
    ]).toStrictEqual([true, false, false]);
  });
});
