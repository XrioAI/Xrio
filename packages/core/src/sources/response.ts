import type { ResponseDetails } from "../types.ts";

export const responseDetailsFrom = (
  url: string,
  status: number,
  rawHeaders: Iterable<readonly [string, string]>,
): ResponseDetails => {
  const headers: ResponseDetails["headers"] = {};
  const cookies: string[] = [];

  for (const [name, value] of rawHeaders) {
    const key = name.toLowerCase();
    const values = value.split("\n");

    if (key === "set-cookie") {
      cookies.push(...values);
    } else {
      const joined = values.join(", ");
      const existing = headers[key];

      headers[key] = existing === undefined ? joined : `${existing}, ${joined}`;
    }
  }

  return { cookies, headers, status, url };
};
