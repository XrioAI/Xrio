import { createHash } from "node:crypto";
import path from "node:path";

import type { FontStack } from "./contracts.ts";

export const FONT_CONFIG_NAME = "fonts.conf";

export type FontRead = "full" | "sentinel";

export const FONT_SENTINEL_FAMILIES = ["Ubuntu", "KACSTOffice"] as const;

export const FONT_PROBE_FAMILIES = [
  "DejaVu Sans",
  "DejaVu Sans Mono",
  "DejaVu Serif",
  "Liberation Sans",
  "Liberation Serif",
  "Liberation Mono",
  "Liberation Sans Narrow",
  "Abyssinica SIL",
  "Lohit Tamil",
  "Padauk",
  "Noto Color Emoji",
  "KACSTOffice",
  "OpenSymbol",
  "Ubuntu",
  "Arimo",
  "Cousine",
  "Chilanka",
  "PMingLiU",
  "Arial Unicode MS",
  "Bitstream Vera Sans Mono",
  "Calibri",
  "Century Gothic",
  "Gill Sans",
  "Helvetica Neue",
  "Lucida Bright",
  "Menlo",
  "MS Mincho",
  "Monotype Corsiva",
  "SimHei",
  "Batang",
  "Franklin Gothic",
  "Minion Pro",
  "Geneva",
  "Cambria Math",
  "Lucida Console",
  "Segoe UI Emoji",
  "Droid Sans Mono",
  "Roboto",
  "Source Code Pro",
  "Amiri",
] as const;

const USER_RULES: ReadonlySet<string> = new Set(["50-user.conf", "51-local.conf"]);

const escaped = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const fontConfigPathOf = ({ directory }: Pick<FontStack, "directory">): string =>
  path.join(directory, "fonts");

export const fontConfigOf = ({ cacheDir, directory, rules }: FontStack): string =>
  [
    '<?xml version="1.0"?>',
    '<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">',
    "<fontconfig>",
    `  <dir>${escaped(path.join(directory, "share"))}</dir>`,
    `  <cachedir>${escaped(cacheDir)}</cachedir>`,
    ...rules
      .filter((rule) => !USER_RULES.has(rule))
      .toSorted()
      .map(
        (rule) =>
          `  <include ignore_missing="no">${escaped(path.join(fontConfigPathOf({ directory }), "conf.d", rule))}</include>`,
      ),
    "</fontconfig>",
    "",
  ].join("\n");

export const fontConfigDigestOf = (stack: FontStack): string =>
  createHash("sha256")
    .update(fontConfigOf({ ...stack, cacheDir: "@cache", directory: "@stack" }))
    .digest("hex");

export const fontCheckEnvironment = (
  stack: FontStack,
  { configFile, home }: { readonly configFile: string; readonly home: string },
) => ({
  FONTCONFIG_FILE: configFile,
  FONTCONFIG_PATH: fontConfigPathOf(stack),
  HOME: home,
  XDG_CACHE_HOME: path.join(home, ".cache"),
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_DATA_HOME: path.join(home, ".local", "share"),
});
