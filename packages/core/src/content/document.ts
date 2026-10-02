import { htmlToMarkdown } from "@mdream/js";
import type { ElementNode, TransformPlugin } from "@mdream/js";

import type { RenderedDocument } from "../types.ts";

export const htmlPlugins = { tagOverrides: { noscript: "div" } } as const;

export const isDocumentTitle = (node: ElementNode): boolean =>
  node.name === "title" &&
  (!node.parent || node.parent.name === "head" || node.parent.name === "html");

export const isBodyElement = (node: ElementNode): boolean => {
  let { parent } = node;

  while (parent) {
    if (parent.name === "head") {
      return false;
    }

    ({ parent } = parent);
  }

  return true;
};

export const bodyContent: TransformPlugin = {
  onNodeEnter(node) {
    if (node.name === "head" || isDocumentTitle(node)) {
      node.excludedFromMarkdown = true;
    }
  },
};

export const resolveUrl = (value: string, baseUrl: string): string =>
  URL.parse(value, baseUrl)?.href ?? value;

export const readBaseUrl = ({ html, url }: RenderedDocument): string => {
  let baseHref: string | undefined;

  htmlToMarkdown(html, {
    hooks: [
      {
        onNodeEnter(node) {
          node.excludedFromMarkdown = true;

          if (node.name === "base") {
            baseHref ??= node.attributes.href;
          }
        },
      },
    ],
    plugins: htmlPlugins,
  });

  return URL.parse(baseHref ?? url, url)?.href ?? url;
};
