import { writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import manifest from "../package.json" with { type: "json" };
import { extractContent, getHtml, renderMarkdown } from "../src/content/formats.ts";
import type { RenderedDocument } from "../src/types.ts";

const KIB = 1024;

const MIB = 1024 * KIB;

const CAPTURE_CAP_BYTES = 32 * MIB;

const PAGE_URL = "https://shop.example.com/catalog/page?ref=bench";

const LOOP_RESOLUTION_MS = 1;

const SETTLE_MS = 25;

const IDLE_PROBE_MS = 500;

type Layout = "article" | "listing" | "mixed";

interface PageSpec {
  readonly bytes: number;
  readonly name: string;
  readonly layout: Layout;
}

const PAGE_SPECS: readonly PageSpec[] = [
  { bytes: 100 * KIB, layout: "article", name: "article-100KiB" },
  { bytes: 2 * MIB, layout: "listing", name: "listing-2MiB" },
  { bytes: 10 * MIB, layout: "mixed", name: "mixed-10MiB" },
  { bytes: CAPTURE_CAP_BYTES - 16 * KIB, layout: "mixed", name: "cap-32MiB" },
];

const FORMATS = ["html", "markdown", "json"] as const;

type Format = (typeof FORMATS)[number];

const conversions: Record<Format, (document: RenderedDocument) => number> = {
  html: (document) => getHtml(document).length,
  json: (document) => {
    const { content } = extractContent(document);

    return content.markdown.length + content.text.length;
  },
  markdown: (document) => renderMarkdown(document).length,
};

const { values } = parseArgs({
  options: {
    only: { type: "string" },
    out: { type: "string" },
    runs: { default: "20", type: "string" },
    warmup: { default: "2", type: "string" },
  },
});

const parseCount = (flag: string, value: string, minimum: number): number => {
  const count = Number(value);

  if (!Number.isInteger(count) || count < minimum) {
    throw new Error(`--${flag} must be an integer of at least ${minimum}, not "${value}".`);
  }

  return count;
};

const parseSpecs = (value: string | undefined): readonly PageSpec[] => {
  if (value === undefined) {
    return PAGE_SPECS;
  }

  const names = value.split(",");
  const unknown = names.filter((name) => !PAGE_SPECS.some((spec) => spec.name === name));

  if (unknown.length > 0) {
    throw new Error(
      `--only names unknown pages ${unknown.join(", ")}; known: ${PAGE_SPECS.map((spec) => spec.name).join(", ")}.`,
    );
  }

  return PAGE_SPECS.filter((spec) => names.includes(spec.name));
};

const runs = parseCount("runs", values.runs, 1);

const warmup = parseCount("warmup", values.warmup, 0);

const specs = parseSpecs(values.only);

const words = [
  "market",
  "season",
  "quiet",
  "river",
  "signal",
  "harvest",
  "craft",
  "window",
  "pattern",
  "summit",
  "garden",
  "ledger",
  "orbit",
  "canvas",
  "meadow",
  "beacon",
];

const sentence = (seed: number, length: number): string =>
  Array.from({ length }, (_, index) => words[(seed * 7 + index * 3) % words.length]).join(" ");

const pageHead = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Catalog - Example Shop</title><meta name="description" content="Browse the full catalog of seasonal goods."><meta name="viewport" content="width=device-width, initial-scale=1"><base href="https://shop.example.com/catalog/"><link rel="stylesheet" href="/assets/app.css"><link rel="canonical" href="https://shop.example.com/catalog/page"><style>${".grid-item{display:flex;flex:1 1 240px;margin:0 0 16px}.card{border:1px solid #ddd;padding:12px}".repeat(40)}</style><script type="application/ld+json">{"@context":"https://schema.org","@type":"CollectionPage","name":"Catalog","url":"https://shop.example.com/catalog/page"}</script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag("js",new Date());${"gtag('event','impression',{items:[]});".repeat(30)}</script></head>`;

const navigation = `<header class="site-header"><nav aria-label="Main"><ul>${Array.from(
  { length: 40 },
  (_, index) =>
    `<li class="nav-item"><a href="/category/${index}">Category ${index}</a><div class="flyout"><a href="/category/${index}/new">New</a><a href="/category/${index}/sale">Sale</a></div></li>`,
).join("")}</ul></nav></header>`;

const footer = `<footer class="site-footer"><div class="columns">${Array.from(
  { length: 6 },
  (_, column) =>
    `<div class="column"><h4>Column ${column}</h4><ul>${Array.from(
      { length: 10 },
      (__, index) => `<li><a href="/help/${column}/${index}">Help topic ${index}</a></li>`,
    ).join("")}</ul></div>`,
).join(
  "",
)}</div><noscript><img src="/pixel.gif" alt=""></noscript><script src="/assets/app.js" async></script></footer></body></html>`;

const articleBlock = (index: number): string => {
  const rows = Array.from(
    { length: 6 },
    (_, row) =>
      `<tr><td>${sentence(index + row, 2)}</td><td>${(index * 13 + row * 7) % 1000}</td><td><a href="/data/${index}/${row}">detail</a></td><td>${sentence(row, 1)}</td></tr>`,
  ).join("");

  const items = Array.from(
    { length: 5 },
    (_, item) =>
      `<li><a href="/reading/${index}-${item}" title="${sentence(item, 2)}">${sentence(index + item, 4)}</a></li>`,
  ).join("");

  return `<section class="post-section" id="s${index}"><h2>${sentence(index, 4)}</h2><div class="prose"><p>${sentence(index, 24)} <a href="/topics/${index}">${sentence(index, 2)}</a> ${sentence(index + 1, 18)} <em>${sentence(index + 2, 2)}</em> and <strong>${sentence(index + 3, 3)}</strong> with <code>value_${index}</code>.</p><p>${sentence(index + 4, 30)}</p><ul>${items}</ul><figure><img src="/img/story-${index}.jpg" alt="${sentence(index, 3)}" width="800" height="450" loading="lazy"><figcaption>${sentence(index + 5, 8)}</figcaption></figure><blockquote><p>${sentence(index + 6, 20)}</p></blockquote><table class="data"><thead><tr><th>Name</th><th>Value</th><th>Link</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table><pre><code class="language-ts">const value${index} = compute(${index});\nconsole.log(value${index});</code></pre></div></section>`;
};

const listingBlock = (index: number): string => {
  const price = 5 + ((index * 37) % 400);

  const stars = Array.from({ length: 5 }, () => '<span class="star">&#9733;</span>').join("");

  const inlineData =
    index % 25 === 0
      ? `<script>window.__ITEMS__=(window.__ITEMS__||[]).concat([${Array.from({ length: 25 }, (_, offset) => `{"id":${index + offset},"price":${price}}`).join(",")}]);</script><style>.grid-item-${index}{order:${index}}</style>`
      : "";

  return `<div class="grid-item grid-item-${index}"><div class="card"><a class="card-link" href="/p/${index}?ref=grid&amp;pos=${index}"><div class="thumb"><img src="https://cdn.example.com/p/${index}/400.webp" srcset="https://cdn.example.com/p/${index}/200.webp 200w, https://cdn.example.com/p/${index}/400.webp 400w" alt="Product ${index} ${sentence(index, 2)}" loading="lazy"></div></a><div class="meta"><h3 class="title"><a href="/p/${index}">${sentence(index, 4)}</a></h3><div class="rating">${stars}<span class="count">(${index % 900})</span></div><div class="price"><span class="was">$${price + 10}.00</span> <span class="now">$${price}.00</span></div><ul class="badges"><li>Free shipping</li><li><a href="/brand/${index % 50}">Brand ${index % 50}</a></li><li>${sentence(index, 2)}</li></ul><a class="btn" href="/cart/add/${index}" data-sku="SKU-${index}">Add to cart</a></div></div></div>${inlineData}`;
};

const blockFor = (layout: Layout, index: number): string => {
  if (layout === "article") {
    return articleBlock(index);
  }

  if (layout === "listing") {
    return listingBlock(index);
  }

  return index % 4 === 0 ? articleBlock(index) : listingBlock(index);
};

const buildPage = ({ bytes, layout }: PageSpec): string => {
  const parts = [pageHead, "<body>", navigation, '<main class="content">'];
  let length = pageHead.length + navigation.length + footer.length;

  for (let index = 0; length < bytes; index += 1) {
    const block = blockFor(layout, index);

    parts.push(block);
    length += block.length;
  }

  parts.push("</main>", footer);

  return parts.join("");
};

const countOccurrences = (haystack: string, needle: string): number => {
  let count = 0;

  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + needle.length)
  ) {
    count += 1;
  }

  return count;
};

interface Run {
  readonly loopDelayMs: number;
  readonly outputChars: number;
  readonly wallMs: number;
}

const maxLoopDelayMs = (histogram: ReturnType<typeof monitorEventLoopDelay>): number =>
  histogram.max / 1e6;

const measureIdleLoopDelayMs = async (): Promise<number> => {
  const histogram = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });

  histogram.enable();
  await sleep(IDLE_PROBE_MS);
  histogram.disable();

  return maxLoopDelayMs(histogram);
};

const convertOnce = async (format: Format, document: RenderedDocument): Promise<Run> => {
  const histogram = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });

  histogram.enable();
  await sleep(SETTLE_MS);

  const started = performance.now();
  const outputChars = conversions[format](document);
  const wallMs = performance.now() - started;

  await sleep(SETTLE_MS);
  histogram.disable();

  return { loopDelayMs: maxLoopDelayMs(histogram), outputChars, wallMs };
};

const percentile = (sorted: readonly number[], rank: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil((rank / 100) * sorted.length) - 1)] ?? Number.NaN;

const round = (value: number): number => Number(value.toFixed(1));

const summarise = (samples: readonly number[]) => {
  const sorted = samples.toSorted((a, b) => a - b);

  return {
    max: round(sorted.at(-1) ?? Number.NaN),
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
  };
};

const benchFormat = async (format: Format, document: RenderedDocument) => {
  for (let index = 0; index < warmup; index += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    await convertOnce(format, document);
  }

  const samples: Run[] = [];

  for (let index = 0; index < runs; index += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    samples.push(await convertOnce(format, document));
  }

  return {
    loopDelayMs: summarise(samples.map((sample) => sample.loopDelayMs)),
    outputChars: samples[0]?.outputChars ?? 0,
    samples,
    wallMs: summarise(samples.map((sample) => sample.wallMs)),
  };
};

const benchPage = async (spec: PageSpec) => {
  const html = buildPage(spec);
  const document: RenderedDocument = { html, scriptsRan: true, url: PAGE_URL };
  const formats: Record<string, Awaited<ReturnType<typeof benchFormat>>> = {};

  for (const format of FORMATS) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    formats[format] = await benchFormat(format, document);
  }

  return {
    anchors: countOccurrences(html, "<a "),
    formats,
    htmlBytes: Buffer.byteLength(html),
    images: countOccurrences(html, "<img "),
    layout: spec.layout,
    name: spec.name,
  };
};

const idleLoopDelayMs = await measureIdleLoopDelayMs();

const pages = [];

for (const spec of specs) {
  // oxlint-disable-next-line eslint/no-await-in-loop
  pages.push(await benchPage(spec));
}

const report = {
  config: {
    captureCapBytes: CAPTURE_CAP_BYTES,
    cpuModel: cpus()[0]?.model ?? "unknown",
    idleLoopDelayMs: round(idleLoopDelayMs),
    loopResolutionMs: LOOP_RESOLUTION_MS,
    node: process.version,
    packages: { "@mdream/js": manifest.devDependencies["@mdream/js"] },
    platform: `${process.platform}-${process.arch}`,
    runs,
    warmup,
  },
  results: pages,
};

if (values.out !== undefined) {
  await writeFile(values.out, `${JSON.stringify(report, undefined, 2)}\n`);
}

const summary = pages.map(({ formats, htmlBytes, name }) => ({
  formats: Object.fromEntries(
    Object.entries(formats).map(([format, result]) => [
      format,
      { loopDelayMs: result.loopDelayMs, wallMs: result.wallMs },
    ]),
  ),
  htmlBytes,
  name,
}));

process.stdout.write(
  `${JSON.stringify({ idleLoopDelayMs: report.config.idleLoopDelayMs, summary }, undefined, 2)}\n`,
);
