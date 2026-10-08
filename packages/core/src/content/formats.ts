import { htmlToMarkdown } from "@mdream/js";
import { extractionPlugin } from "@mdream/js/plugins";

import type { RenderedDocument, StructuredContent } from "../types.ts";
import {
  bodyContentFor,
  htmlPlugins,
  isBodyElement,
  isDocumentTitle,
  isScriptFallback,
  readBaseUrl,
  resolveUrl,
} from "./document.ts";

export const getHtml = ({ html }: RenderedDocument): string => html;

export const renderMarkdown = (
  document: RenderedDocument,
  baseUrl = readBaseUrl(document),
): string =>
  htmlToMarkdown(document.html, {
    hooks: [
      bodyContentFor(document),
      {
        processAttributes(node) {
          const { attributes } = node;

          if (node.name === "a" && attributes.href !== undefined) {
            attributes.href = resolveUrl(attributes.href, baseUrl);
          }

          if (node.name === "img" && attributes.src !== undefined) {
            attributes.src = resolveUrl(attributes.src, baseUrl);
          }
        },
      },
    ],
    plugins: htmlPlugins,
  });

export const extractContent = (document: RenderedDocument): StructuredContent => {
  const { html, url } = document;

  const metadata: StructuredContent["metadata"] = {
    description: null,
    language: null,
    title: null,
    url,
  };

  const links: StructuredContent["content"]["links"] = [];
  const images: StructuredContent["content"]["images"] = [];
  let baseHref: string | undefined;

  const extraction = extractionPlugin({
    "a[href]": (node) => {
      if (isBodyElement(node, document.scriptsRan)) {
        links.push({ href: node.attributes.href, text: node.textContent });
      }
    },
    "base[href]": (node) => {
      if (!isScriptFallback(node, document.scriptsRan)) {
        baseHref ??= node.attributes.href;
      }
    },
    "html[lang]": ({ attributes }) => {
      metadata.language ??= attributes.lang;
    },
    "img[src]": (node) => {
      if (isBodyElement(node, document.scriptsRan)) {
        images.push({ alt: node.attributes.alt ?? "", src: node.attributes.src });
      }
    },
    "meta[name][content]": (node) => {
      const { attributes } = node;

      if (
        attributes.name.toLowerCase() === "description" &&
        !isScriptFallback(node, document.scriptsRan)
      ) {
        metadata.description ??= attributes.content;
      }
    },
    title: (node) => {
      if (isDocumentTitle(node)) {
        metadata.title ??= node.textContent;
      }
    },
  });

  const text = htmlToMarkdown(html, {
    format: "text",
    hooks: [bodyContentFor(document), extraction],
    plugins: htmlPlugins,
  });

  const baseUrl = URL.parse(baseHref ?? url, url)?.href ?? url;

  return {
    content: {
      images: images.map(({ alt, src }) => ({ alt, src: resolveUrl(src, baseUrl) })),
      links: links.map(({ text: label, href }) => ({
        href: resolveUrl(href, baseUrl),
        text: label,
      })),
      markdown: renderMarkdown(document, baseUrl),
      text,
    },
    metadata,
  };
};
