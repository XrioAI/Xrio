import path from "node:path";

import { defineRule } from "vite-plus/lint/plugins";
import type { ESTree } from "vite-plus/lint/plugins";

const DOWNSTREAM = /\/packages\/core\/src\/(?:sources|humanizer)\//u;

const MANAGER =
  /\/packages\/core\/src\/(?:sessions\/|proxy\/(?:route|routes|exit|manager|info)\.ts$|coordinator\.ts$)/u;

const isText = (value: unknown): value is string => typeof value === "string";

const moduleText = (source: ESTree.Node): string | undefined => {
  if (source.type === "Literal" && isText(source.value)) {
    return source.value;
  }

  return source.type === "TemplateLiteral" && source.expressions.length === 0
    ? (source.quasis[0]?.value.cooked ?? undefined)
    : undefined;
};

export default defineRule({
  create: (context) => {
    const filename = path.resolve(context.filename);

    const check = (source: ESTree.Node | null | undefined) => {
      if (source === undefined || source === null || !DOWNSTREAM.test(filename)) {
        return;
      }

      const specifier = moduleText(source);

      if (specifier === undefined) {
        return;
      }

      const target = path.resolve(path.dirname(filename), specifier);

      if (MANAGER.test(target)) {
        context.report({ data: { path: specifier }, messageId: "upward", node: source });
      }
    };

    return {
      ExportAllDeclaration: (node) => {
        check(node.source);
      },
      ExportNamedDeclaration: (node) => {
        check(node.source);
      },
      ImportDeclaration: (node) => {
        check(node.source);
      },
      ImportExpression: (node) => {
        check(node.source);
      },
    };
  },
  meta: {
    messages: {
      upward:
        "`{{path}}` belongs to a manager. Sources and the Humanizer consume complete plans and cannot call upward.",
    },
    type: "problem",
  },
});
