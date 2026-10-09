import { GPU_POLICIES } from "./humanizer/contracts.ts";
import {
  CHROME_ACCEPT_LANGUAGES,
  FORK_MAX_CORES,
  GL_PERSONA_MAX_NAME,
  GL_PERSONA_NAME_PATTERN,
  REPORTABLE_MEMORY_GB,
} from "./humanizer/owned-inputs.ts";
import { MAX_SESSION_LENGTH, SESSION_FORMATS, SESSION_PLACEHOLDER } from "./proxy/config.ts";

export interface JsonSchema {
  readonly $schema?: string;
  readonly title?: string;
  readonly description?: string;
  readonly type?: "object" | "array" | "string" | "integer" | "number" | "boolean";
  readonly enum?: readonly (string | number)[];
  readonly const?: string | boolean;
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly minItems?: number;
  readonly items?: JsonSchema;
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- A schema's properties are keyed by the configuration's own field names.
  readonly properties?: Readonly<Partial<Record<string, DescribedSchema>>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- A schema's dependencies are keyed by the configuration's own field names.
  readonly dependencies?: Readonly<Partial<Record<string, JsonSchema | readonly string[]>>>;
  readonly oneOf?: readonly JsonSchema[];
}

interface DescribedSchema extends JsonSchema {
  readonly description: string;
}

const WEIGHT: DescribedSchema = {
  description:
    "How likely a browser is to draw this row, relative to the weights of the other rows. A positive number.",
  exclusiveMinimum: 0,
  type: "number",
};

const wholePixels = (description: string, minimum: number): DescribedSchema => ({
  description,
  maximum: Number.MAX_SAFE_INTEGER,
  minimum,
  type: "integer",
});

const objectOf = (
  description: string,
  properties: NonNullable<JsonSchema["properties"]>,
  extra: Pick<JsonSchema, "dependencies" | "required"> = {},
): DescribedSchema => ({
  additionalProperties: false,
  description,
  ...extra,
  properties,
  type: "object",
});

const asTableRow = (description: string): string =>
  `One row of a weighted table: ${description.charAt(0).toLowerCase()}${description.slice(1, -1)}, plus a weight.`;

const weighted = ({
  dependencies,
  description,
  properties,
  required = [],
}: DescribedSchema): DescribedSchema =>
  objectOf(
    asTableRow(description),
    { ...properties, weight: WEIGHT },
    { dependencies, required: [...required, "weight"] },
  );

const valueOrTable = (
  description: string,
  value: JsonSchema,
  row: JsonSchema,
): DescribedSchema => ({
  description,
  oneOf: [value, { items: row, minItems: 1, type: "array" }],
});

const SCREEN = objectOf(
  "A screen size in whole pixels.",
  {
    height: wholePixels("Screen height in whole pixels.", 1),
    width: wholePixels("Screen width in whole pixels.", 1),
  },
  { required: ["width", "height"] },
);

const TASKBAR = objectOf("The space the desktop's panels take at each edge, in whole pixels.", {
  bottom: wholePixels("Height of a panel along the bottom edge, in whole pixels.", 0),
  left: wholePixels("Width of a panel along the left edge, in whole pixels.", 0),
  right: wholePixels("Width of a panel along the right edge, in whole pixels.", 0),
  top: wholePixels("Height of a panel along the top edge, in whole pixels.", 0),
});

const WINDOW_SIZE = objectOf(
  "A window size in whole pixels, with an optional position.",
  {
    height: wholePixels("Window height in whole pixels.", 1),
    width: wholePixels("Window width in whole pixels.", 1),
    x: wholePixels("Distance from the left edge of the screen. Give x and y together.", 0),
    y: wholePixels("Distance from the top edge of the screen. Give x and y together.", 0),
  },
  { dependencies: { x: ["y"], y: ["x"] }, required: ["width", "height"] },
);

const MAXIMIZED_ROW = weighted(
  objectOf(
    "A window that fills the work area.",
    { maximized: { const: true, description: "Fill the work area.", type: "boolean" } },
    { required: ["maximized"] },
  ),
);

const DISPLAY = objectOf(
  "The screen, desktop panels and window a headless browser presents. Whatever is left out is drawn from Xrio's own tables. A headed browser keeps the real display.",
  {
    screen: valueOrTable(
      "The screen size a headless browser presents, or a weighted table of sizes.",
      SCREEN,
      weighted(SCREEN),
    ),
    taskbar: valueOrTable(
      "The space the desktop's panels take at each edge. The rest of the screen is the work area, which a maximized window fills and which screen.availWidth and screen.availHeight report. An empty object means no panels. Also takes a weighted table.",
      TASKBAR,
      weighted(TASKBAR),
    ),
    window: {
      description:
        'The browser window: "maximized", a size with an optional position, or a weighted table of sizes and maximized rows.',
      oneOf: [
        { const: "maximized", type: "string" },
        WINDOW_SIZE,
        {
          items: { oneOf: [weighted(WINDOW_SIZE), MAXIMIZED_ROW] },
          minItems: 1,
          type: "array",
        },
      ],
    },
  },
);

const hardwareValue = (description: string, value: DescribedSchema): DescribedSchema =>
  valueOrTable(
    description,
    value,
    weighted(objectOf(value.description, { value }, { required: ["value"] })),
  );

const GL_PERSONA_NAME: DescribedSchema = {
  description: "The name of one of the Chromium fork package's GL personas.",
  maxLength: GL_PERSONA_MAX_NAME,
  minLength: 1,
  pattern: GL_PERSONA_NAME_PATTERN,
  type: "string",
};

const HARDWARE = objectOf(
  "The cores, memory and GL persona a browser presents, and the policy for choosing a GL persona. Only a package of Xrio's Chromium fork can present them. On stock Chrome, cores and memoryGb fall back to the host's own values, and a gpu pin rejects every browser scrape. Whatever is left out is drawn from Xrio's own tables.",
  {
    cores: hardwareValue(
      "The logical core count a browser presents, or a weighted table of counts.",
      {
        description: "A whole number of cores.",
        maximum: FORK_MAX_CORES,
        minimum: 1,
        type: "integer",
      },
    ),
    gpu: valueOrTable(
      "The GL persona a browser presents, or a weighted table of personas. Only a fork package can present one, and on stock Chrome a gpu pin rejects every browser scrape.",
      GL_PERSONA_NAME,
      weighted(
        objectOf(GL_PERSONA_NAME.description, { name: GL_PERSONA_NAME }, { required: ["name"] }),
      ),
    ),
    gpuPolicy: {
      description:
        "When a hardware GL persona is presented. announce, the default, presents one over SwiftShader too. matched presents one only on a GPU whose own renderer equals it.",
      enum: GPU_POLICIES,
      type: "string",
    },
    memoryGb: hardwareValue(
      "The device memory in GB a browser presents, or a weighted table of values.",
      {
        description: "A value Chrome reports for navigator.deviceMemory.",
        enum: REPORTABLE_MEMORY_GB,
        type: "integer",
      },
    ),
  },
);

const HOST = objectOf(
  "The locale, timezone, display and hardware that every scrape of the client presents, plus extra Chrome switches. Browser scrapes use each field the browser can present, and http scrapes use only locale. A scrape cannot override them. A browserArgs option on the client replaces host.browserArgs.",
  {
    browserArgs: {
      description:
        'Chrome switches added to every browser scrape, each as "--name" or "--name=value". A browserArgs option on the client replaces this list. Switches Xrio manages are refused when the config loads.',
      items: { pattern: "^--[^=\\s]", type: "string" },
      type: "array",
    },
    display: DISPLAY,
    hardware: HARDWARE,
    locale: {
      description:
        "The language tag every scrape presents, such as de-DE, written in its canonical casing. Xrio offers only the tags it has measured Chrome's language list for. It wins over the locale inferred from the proxy exit. In http mode it sets only Accept-Language.",
      enum: Object.keys(CHROME_ACCEPT_LANGUAGES),
      type: "string",
    },
    timezone: {
      description:
        "The IANA zone name a browser presents, such as Europe/Berlin. It wins over the proxy exit's zone, and http scrapes ignore it. Offsets such as +05:30 are refused when the config loads.",
      minLength: 1,
      type: "string",
    },
  },
);

const SESSION_PLACEHOLDER_PATTERN = SESSION_PLACEHOLDER.replaceAll(
  /[{}]/gu,
  (brace) => `\\${brace}`,
);

const PROXY = objectOf(
  "The proxy every scrape uses unless the client or the scrape passes its own proxy URL.",
  {
    session: objectOf(
      `How Xrio generates the ID that replaces ${SESSION_PLACEHOLDER} in proxy.url. Xrio generates a new ID at runtime, so the config cannot name one.`,
      {
        format: {
          description: "The characters of a generated session ID. Defaults to numeric.",
          enum: SESSION_FORMATS,
          type: "string",
        },
        length: {
          description: "The length of a generated session ID. Defaults to 8.",
          maximum: MAX_SESSION_LENGTH,
          minimum: 1,
          type: "integer",
        },
      },
    ),
    url: {
      description: `The proxy as scheme://[user:password@]host[:port], with http, https, socks5 or socks5h. A ${SESSION_PLACEHOLDER} placeholder in the username or password asks Xrio to generate a session ID.`,
      minLength: 1,
      type: "string",
    },
  },
  {
    dependencies: {
      session: {
        properties: {
          url: {
            description: `A proxy with session settings needs a ${SESSION_PLACEHOLDER} placeholder in its URL.`,
            pattern: SESSION_PLACEHOLDER_PATTERN,
            type: "string",
          },
        },
      },
    },
    required: ["url"],
  },
);

const SCRAPE = objectOf("Settings that apply to every scrape of the client.", {
  retries: {
    description:
      "How many more attempts a scrape makes after NETWORK_ERROR, PROXY_UNREACHABLE, PROXY_CONNECT_FAILED or BROWSER_CRASHED. Defaults to 0. Every attempt shares the scrape's timeoutMs deadline, and HTTP statuses and blocked pages are never retried.",
    maximum: Number.MAX_SAFE_INTEGER,
    minimum: 0,
    type: "integer",
  },
});

export const XRIO_CONFIG_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  ...objectOf(
    "Configuration for @xrio/core. XrioClient reads it from xrio.config.json in the working directory, or from the file that its configFile option names.",
    {
      $schema: {
        description: "The location of this schema. Editors read it, and Xrio ignores it.",
        type: "string",
      },
      host: HOST,
      proxy: PROXY,
      scrape: SCRAPE,
    },
  ),
  title: "xrio.config",
} satisfies JsonSchema;
