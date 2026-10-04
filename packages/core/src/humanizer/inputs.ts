import type { LaunchInput } from "./owned-inputs.ts";
import { EMISSION_ORDER } from "./surfaces.ts";
import type { SurfaceName } from "./surfaces.ts";

const MINTED = Symbol("BrowserInputs");

const minted = new WeakSet<object>();

interface JsonObject {
  [key: string]: string | number | JsonObject;
}

export interface BrowserInputs {
  readonly [MINTED]: true;
  readonly switches: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly preferences: Readonly<JsonObject>;
  readonly localState: Readonly<JsonObject>;
}

export const isMinted = (inputs: BrowserInputs): boolean => minted.has(inputs);

const isJsonObject = (value: string | number | JsonObject | undefined): value is JsonObject =>
  typeof value === "object";

const placeAt = (root: JsonObject, path: string, value: string | number): void => {
  const [leaf, ...parents] = path.split(".").toReversed();
  let node = root;

  for (const segment of parents.toReversed()) {
    const existing = node[segment];
    const child: JsonObject = isJsonObject(existing) ? existing : {};

    node[segment] = child;
    node = child;
  }

  node[leaf] = value;
};

const freezeJson = (node: JsonObject): Readonly<JsonObject> => {
  for (const child of Object.values(node)) {
    if (isJsonObject(child)) {
      freezeJson(child);
    }
  }

  return Object.freeze(node);
};

type EmittedInputs = Readonly<Record<SurfaceName, { readonly inputs: readonly LaunchInput[] }>>;

export const mergeBrowserInputs = (resolutions: EmittedInputs): BrowserInputs => {
  const owners = new Map<string, SurfaceName>();
  const switches: string[] = [];
  const environment: Record<string, string> = {};
  const preferences: JsonObject = {};
  const localState: JsonObject = {};

  const place = (input: LaunchInput): void => {
    switch (input.sink) {
      case "switch": {
        switches.push(`${input.name}=${input.value}`);
        break;
      }

      case "environment": {
        environment[input.name] = input.value;
        break;
      }

      case "preference": {
        placeAt(preferences, input.name, input.value);
        break;
      }

      case "local-state": {
        placeAt(localState, input.name, input.value);
        break;
      }

      default: {
        throw new Error(`No placement for ${JSON.stringify(input satisfies never)}.`);
      }
    }
  };

  for (const surface of EMISSION_ORDER) {
    for (const input of resolutions[surface].inputs) {
      const key = `${input.sink} ${input.name}`;
      const owner = owners.get(key);

      if (owner !== undefined) {
        throw new Error(`The ${owner} and ${surface} surfaces both emit the ${key}.`);
      }

      owners.set(key, surface);
      place(input);
    }
  }

  const inputs: BrowserInputs = {
    [MINTED]: true,
    environment: Object.freeze(environment),
    localState: freezeJson(localState),
    preferences: freezeJson(preferences),
    switches: Object.freeze(switches),
  };

  minted.add(Object.freeze(inputs));

  return inputs;
};
