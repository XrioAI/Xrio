import { htmlToMarkdown } from "@mdream/js";
import { extractionPlugin } from "@mdream/js/plugins";

import type { SourceDocument, StructuredContent } from "../types.ts";
import {
  bodyContent,
  htmlPlugins,
  isBodyElement,
  isDocumentTitle,
  readBaseUrl,
  resolveUrl,
} from "./document.ts";

export const getHtml = ({ html }: SourceDocument): string => html;

export const renderMarkdown = (document: SourceDocument, baseUrl = readBaseUrl(document)): string =>
  htmlToMarkdown(document.html, {
    hooks: [
      bodyContent,
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

export const extractContent = (document: SourceDocument): StructuredContent => {
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

  const text = htmlToMarkdown(html, {
    format: "text",
    hooks: [bodyContent, extraction],
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
