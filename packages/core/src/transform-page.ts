import { htmlToMarkdown } from "@mdream/js";
import type { ElementNode, TransformPlugin } from "@mdream/js";
import { extractionPlugin } from "@mdream/js/plugins";

import type { AcquiredPage, JsonPage, ScrapeFormat } from "./types.ts";

const plugins = { tagOverrides: { noscript: "div" } } as const;

const isDocumentTitle = (node: ElementNode): boolean =>
  node.name === "title" &&
  (!node.parent || node.parent.name === "head" || node.parent.name === "html");

const isBodyElement = (node: ElementNode): boolean => {
  let { parent } = node;

  while (parent) {
    if (parent.name === "head") {
      return false;
    }

    ({ parent } = parent);
  }

  return true;
};

const bodyContent: TransformPlugin = {
  onNodeEnter(node) {
    if (node.name === "head" || isDocumentTitle(node)) {
      node.excludedFromMarkdown = true;
    }
  },
};

const absoluteUrl = (value: string, baseUrl: string): string =>
  URL.parse(value, baseUrl)?.href ?? value;

const extractPage = ({ html, url }: AcquiredPage) => {
  const metadata: JsonPage["metadata"] = {
    description: null,
    language: null,
    title: null,
    url,
  };

  const links: JsonPage["content"]["links"] = [];
  const images: JsonPage["content"]["images"] = [];
  let baseHref: string | undefined;

  const extraction = extractionPlugin({
    "a[href]": (node) => {
      if (isBodyElement(node)) {
        links.push({ href: node.attributes.href, text: node.textContent });
      }
    },
    "base[href]": ({ attributes }) => {
      baseHref ??= attributes.href;
    },
    "html[lang]": ({ attributes }) => {
      metadata.language ??= attributes.lang;
    },
    "img[src]": (node) => {
      if (isBodyElement(node)) {
        images.push({ alt: node.attributes.alt ?? "", src: node.attributes.src });
      }
    },
    "meta[name][content]": ({ attributes }) => {
      if (attributes.name.toLowerCase() === "description") {
        metadata.description ??= attributes.content;
      }
    },
    title: (node) => {
      if (isDocumentTitle(node)) {
        metadata.title ??= node.textContent;
      }
    },
  });

  const text = htmlToMarkdown(html, { format: "text", hooks: [bodyContent, extraction], plugins });
  const baseUrl = URL.parse(baseHref ?? url, url)?.href ?? url;

  return {
    baseUrl,
    images: images.map(({ alt, src }) => ({ alt, src: absoluteUrl(src, baseUrl) })),
    links: links.map(({ text: label, href }) => ({
      href: absoluteUrl(href, baseUrl),
      text: label,
    })),
    metadata,
    text,
  };
};

const renderMarkdown = (html: string, baseUrl: string): string =>
  htmlToMarkdown(html, {
    hooks: [
      bodyContent,
      {
        processAttributes(node) {
          const { attributes } = node;

          if (node.name === "a" && attributes.href !== undefined) {
            attributes.href = absoluteUrl(attributes.href, baseUrl);
          }

          if (node.name === "img" && attributes.src !== undefined) {
            attributes.src = absoluteUrl(attributes.src, baseUrl);
          }
        },
      },
    ],
    plugins,
  });

export const transformPage = (page: AcquiredPage, format: ScrapeFormat): string | JsonPage => {
  if (format === "html") {
    return page.html;
  }

  const { metadata, text, baseUrl, links, images } = extractPage(page);
  const markdown = renderMarkdown(page.html, baseUrl);

  if (format === "markdown") {
    return markdown;
  }

  return { content: { images, links, markdown, text }, metadata };
};
