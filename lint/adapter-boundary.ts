import { definePlugin, defineRule } from "vite-plus/lint/plugins";
import type { ESTree } from "vite-plus/lint/plugins";

const EMULATING_OPTIONS = new Set([
  "proxy",
  "locale",
  "timezoneId",
  "userAgent",
  "viewport",
  "extraHTTPHeaders",
]);

const PAGE_ALTERING_METHOD = /^(?:route|expose)|^addInitScript$/u;

const nameOf = (key: ESTree.PropertyKey): string | undefined => {
  if (key.type === "Identifier") {
    return key.name;
  }

  return key.type === "Literal" ? String(key.value) : undefined;
};

const emulatedOption = (property: ESTree.ObjectProperty): string | undefined => {
  const name = nameOf(property.key);
  const disablesViewport = property.value.type === "Literal" && property.value.value === null;

  return name !== undefined &&
    EMULATING_OPTIONS.has(name) &&
    !(name === "viewport" && disablesViewport)
    ? name
    : undefined;
};

const adapterBoundary = defineRule({
  create: (context) => ({
    MemberExpression: (node) => {
      const method =
        node.computed && node.property.type !== "Literal" ? undefined : nameOf(node.property);

      if (method !== undefined && PAGE_ALTERING_METHOD.test(method)) {
        context.report({ data: { name: method }, messageId: "method", node: node.property });
      }
    },
    ObjectExpression: (node) => {
      for (const property of node.properties) {
        const option = property.type === "Property" ? emulatedOption(property) : undefined;

        if (option !== undefined) {
          context.report({ data: { name: option }, messageId: "option", node: property });
        }
      }
    },
  }),
  meta: {
    messages: {
      method: "`{{name}}` changes what the page sees; the adapter must not call it.",
      option:
        "`{{name}}` makes Patchright emulate or rewrite the browser; take it from launch inputs instead.",
    },
    type: "problem",
  },
});

export default definePlugin({
  meta: { name: "xrio" },
  rules: { "adapter-boundary": adapterBoundary },
});
