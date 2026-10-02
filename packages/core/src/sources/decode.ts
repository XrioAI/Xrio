const META_PRESCAN_BYTES = 1024;

const byteOrderMarks = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: "utf-8" },
  { bytes: [0xfe, 0xff], encoding: "utf-16be" },
  { bytes: [0xff, 0xfe], encoding: "utf-16le" },
] as const;

const CONTENT_TYPE_CHARSET = /;\s*charset\s*=\s*(?:"(?<quoted>[^"]*)"|(?<token>[^;\s]*))/iu;

const META_CONTENT_CHARSET = /charset\s*=\s*["']?(?<label>[^"';\s]+)/iu;

const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/gu;

const META_TAG = /<meta[\s/][^>]*>?/giu;

const TAG_ATTRIBUTE =
  /(?<name>[^\s"'<>/=]+)(?:\s*=\s*(?:"(?<doubleQuoted>[^"]*)"|'(?<singleQuoted>[^']*)'|(?<unquoted>[^\s>]+)))?/gu;

const resolveEncoding = (label: string | undefined): string | undefined => {
  if (label === undefined || label.trim() === "") {
    return undefined;
  }

  try {
    return new TextDecoder(label.trim()).encoding;
  } catch {
    return undefined;
  }
};

const sniffByteOrderMark = (bytes: Uint8Array): string | undefined =>
  byteOrderMarks.find((mark) => mark.bytes.every((byte, index) => bytes[index] === byte))?.encoding;

const readMetaAttributes = (tag: string): Map<string, string> => {
  const attributes = new Map<string, string>();

  for (const { groups } of tag.slice("<meta".length).matchAll(TAG_ATTRIBUTE)) {
    const key = groups?.name?.toLowerCase();

    if (key !== undefined && !attributes.has(key)) {
      attributes.set(key, groups?.doubleQuoted ?? groups?.singleQuoted ?? groups?.unquoted ?? "");
    }
  }

  return attributes;
};

const metaCharsetLabel = (attributes: Map<string, string>): string | undefined => {
  const charset = attributes.get("charset");

  if (charset !== undefined) {
    return charset;
  }

  const declaresContentType = attributes.get("http-equiv")?.toLowerCase() === "content-type";

  return declaresContentType
    ? META_CONTENT_CHARSET.exec(attributes.get("content") ?? "")?.groups?.label
    : undefined;
};

const prescanMetaCharset = (bytes: Uint8Array): string | undefined => {
  const head = new TextDecoder("windows-1252")
    .decode(bytes.subarray(0, META_PRESCAN_BYTES))
    .replaceAll(HTML_COMMENT, "");

  for (const [tag] of head.matchAll(META_TAG)) {
    const encoding = resolveEncoding(metaCharsetLabel(readMetaAttributes(tag)));

    if (encoding === "utf-16be" || encoding === "utf-16le") {
      return "utf-8";
    }

    if (encoding === "x-user-defined") {
      return "windows-1252";
    }

    if (encoding !== undefined) {
      return encoding;
    }
  }

  return undefined;
};

const contentTypeCharset = (contentType: string): string | undefined => {
  const groups = CONTENT_TYPE_CHARSET.exec(contentType)?.groups;

  return resolveEncoding(groups?.quoted ?? groups?.token);
};

export const decodeBody = (bytes: Uint8Array, contentType: string): string => {
  const encoding =
    sniffByteOrderMark(bytes) ??
    contentTypeCharset(contentType) ??
    prescanMetaCharset(bytes) ??
    "utf-8";

  return new TextDecoder(encoding).decode(bytes);
};
