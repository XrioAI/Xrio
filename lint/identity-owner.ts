import { defineRule } from "vite-plus/lint/plugins";
import type { ESTree } from "vite-plus/lint/plugins";

import {
  FORK_SWITCH_PREFIXES,
  OWNED_ENVIRONMENT,
  OWNED_HEADERS,
  OWNED_LOCAL_STATE,
  OWNED_PREFERENCES,
  OWNED_SWITCHES,
} from "../packages/core/src/humanizer/owned-inputs.ts";

type LiteralKind = "switch" | "fork" | "environment" | "preference" | "header";

interface LiteralMatcher {
  readonly kind: LiteralKind;
  readonly find: (text: string) => string | undefined;
}

const PROFILE_SETTINGS: readonly string[] = [...OWNED_PREFERENCES, ...OWNED_LOCAL_STATE];

const literalMatchers: readonly LiteralMatcher[] = [
  {
    find: (text) => OWNED_SWITCHES.find((name) => text === name || text.startsWith(`${name}=`)),
    kind: "switch",
  },
  { find: (text) => FORK_SWITCH_PREFIXES.find((prefix) => text.startsWith(prefix)), kind: "fork" },
  { find: (text) => OWNED_ENVIRONMENT.find((name) => name === text), kind: "environment" },
  { find: (text) => PROFILE_SETTINGS.find((name) => name === text), kind: "preference" },
  { find: (text) => OWNED_HEADERS.find((name) => name === text.toLowerCase()), kind: "header" },
];

const isText = (value: unknown): value is string => typeof value === "string";

interface KeyedProperty {
  readonly computed: boolean;
  readonly key: ESTree.PropertyKey;
}

const plainTemplate = (node: ESTree.Node | null | undefined): string | undefined =>
  node?.type === "TemplateLiteral" && node.expressions.length === 0
    ? (node.quasis[0]?.value.cooked ?? undefined)
    : undefined;

const keyText = ({ computed, key }: KeyedProperty): string | undefined => {
  if (key.type === "Literal") {
    return String(key.value);
  }

  if (key.type === "TemplateLiteral") {
    return plainTemplate(key);
  }

  return !computed && key.type === "Identifier" ? key.name : undefined;
};

const isWrapper = (node: ESTree.Node): boolean =>
  node.type === "TSAsExpression" ||
  node.type === "TSSatisfiesExpression" ||
  node.type === "TSNonNullExpression" ||
  node.type === "ParenthesizedExpression";

const outermostWrapper = (node: ESTree.Node): ESTree.Node => {
  let current = node;

  while (current.parent !== null && isWrapper(current.parent)) {
    ({ parent: current } = current);
  }

  return current;
};

const keyChain = (property: ESTree.ObjectProperty): readonly string[] => {
  const keys: string[] = [];
  let node: ESTree.Node | null = property;

  while (node?.type === "Property") {
    const key = keyText(node);

    if (key === undefined) {
      break;
    }

    keys.unshift(key);

    const owner: ESTree.Node = node.parent;

    if (owner.type !== "ObjectExpression") {
      break;
    }

    ({ parent: node } = outermostWrapper(owner));
  }

  return keys;
};

const settingEndingAt = (property: ESTree.ObjectProperty): string | undefined => {
  const keys = keyChain(property);

  return PROFILE_SETTINGS.find((owned) => {
    const segments = owned.split(".");
    const tail = keys.slice(-segments.length);

    return tail.length === segments.length && tail.every((key, index) => key === segments[index]);
  });
};

const isProcessEnv = (node: ESTree.Expression | ESTree.Super): boolean =>
  node.type === "MemberExpression" &&
  node.object.type === "Identifier" &&
  node.object.name === "process" &&
  node.property.type === "Identifier" &&
  node.property.name === "env";

const memberName = ({ computed, property }: ESTree.MemberExpression): string | undefined =>
  !computed && property.type === "Identifier" ? property.name : undefined;

const ownedVariable = (name: string | undefined): string | undefined =>
  OWNED_ENVIRONMENT.find((owned) => owned === name);

export default defineRule({
  create: (context) => {
    const reportText = (text: string, node: ESTree.Node): void => {
      for (const { find, kind } of literalMatchers) {
        const name = find(text);

        if (name !== undefined) {
          context.report({ data: { name }, messageId: kind, node });

          return;
        }
      }
    };

    const reportProperty = (property: ESTree.ObjectProperty): void => {
      const name = keyText(property);
      const variable = property.key.type === "Identifier" ? ownedVariable(name) : undefined;
      const setting = settingEndingAt(property);

      if (variable !== undefined) {
        context.report({ data: { name: variable }, messageId: "environment", node: property });
      }

      if (setting !== undefined) {
        context.report({ data: { name: setting }, messageId: "preference", node: property });
      }
    };

    return {
      Literal: (node) => {
        if (isText(node.value)) {
          reportText(node.value, node);
        }
      },
      MemberExpression: (node) => {
        const variable = ownedVariable(memberName(node));

        if (variable !== undefined && isProcessEnv(node.object)) {
          context.report({ data: { name: variable }, messageId: "read", node });
        }
      },
      ObjectExpression: (node) => {
        for (const property of node.properties) {
          if (property.type === "Property") {
            reportProperty(property);
          }
        }
      },
      TemplateLiteral: (node) => {
        reportText(node.quasis[0]?.value.cooked ?? "", node);
      },
      VariableDeclarator: (node) => {
        if (node.id.type !== "ObjectPattern" || node.init === null || !isProcessEnv(node.init)) {
          return;
        }

        for (const property of node.id.properties) {
          const variable =
            property.type === "Property" ? ownedVariable(keyText(property)) : undefined;

          if (variable !== undefined) {
            context.report({ data: { name: variable }, messageId: "read", node: property });
          }
        }
      },
    };
  },
  meta: {
    messages: {
      environment:
        "`{{name}}` is an environment variable the Humanizer owns; only src/humanizer/ may use it.",
      fork: "`{{name}}` switches belong to the browser fork's dialect; only src/humanizer/ may emit them.",
      header: "`{{name}}` is a request header the Humanizer owns; only src/humanizer/ may use it.",
      preference:
        "`{{name}}` is a profile setting the Humanizer owns; only src/humanizer/ may write it.",
      read: "`process.env.{{name}}` is read by the Humanizer; take the value from the identity inputs.",
      switch: "`{{name}}` is a launch switch the Humanizer owns; only src/humanizer/ may emit it.",
    },
    type: "problem",
  },
});
