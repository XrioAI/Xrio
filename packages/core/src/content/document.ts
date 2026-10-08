import { htmlToMarkdown } from "@mdream/js";
import type { ElementNode, TransformPlugin } from "@mdream/js";

import type { RenderedDocument } from "../types.ts";

export const htmlPlugins = { tagOverrides: { noscript: "div" } } as const;

export const isDocumentTitle = (node: ElementNode): boolean =>
  node.name === "title" &&
  (!node.parent || node.parent.name === "head" || node.parent.name === "html");

export const isScriptFallback = (node: ElementNode, scriptsRan = false): boolean => {
  if (!scriptsRan) {
    return false;
  }

  let current: ElementNode | null | undefined = node;

  while (current) {
    if (current.name === "noscript") {
      return true;
    }

    current = current.parent;
  }

  return false;
};

export const isBodyElement = (node: ElementNode, scriptsRan = false): boolean => {
  if (isScriptFallback(node, scriptsRan)) {
    return false;
  }

  let { parent } = node;

  while (parent) {
    if (parent.name === "head") {
      return false;
    }

    ({ parent } = parent);
  }

  return true;
};

export const bodyContentFor = (document: RenderedDocument): TransformPlugin => ({
  onNodeEnter(node) {
    if (
      node.name === "head" ||
      isDocumentTitle(node) ||
      (document.scriptsRan === true && node.name === "noscript")
    ) {
      node.excludedFromMarkdown = true;
    }
  },
});

export const resolveUrl = (value: string, baseUrl: string): string =>
  URL.parse(value, baseUrl)?.href ?? value;

export const readBaseUrl = (document: RenderedDocument): string => {
  const { html, url } = document;
  let baseHref: string | undefined;

  htmlToMarkdown(html, {
    hooks: [
      {
        onNodeEnter(node) {
          node.excludedFromMarkdown = true;

          if (node.name === "base" && !isScriptFallback(node, document.scriptsRan)) {
            baseHref ??= node.attributes.href;
          }
        },
      },
    ],
    plugins: htmlPlugins,
  });

  return URL.parse(baseHref ?? url, url)?.href ?? url;
};
