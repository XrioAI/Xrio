import type { SessionRow } from "./store.ts";
import type { Warmth } from "./warmth.ts";

export const choosePoolMember = (
  members: readonly SessionRow[],
  warmth: (name: string) => Warmth,
): SessionRow | undefined => {
  const ready = members.filter((member) => member.state === "ready" && member.holder === undefined);
  const warmed = ready.filter((member) => warmth(member.name) === "warm");

  return (warmed.length > 0 ? warmed : ready).toSorted(
    (left, right) => left.lastVisitAt - right.lastVisitAt || left.name.localeCompare(right.name),
  )[0];
};
