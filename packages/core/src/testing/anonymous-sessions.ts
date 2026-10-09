import { createSessions } from "../sessions/session.ts";
import { profileUse } from "../sources/browser/browser-process.ts";

export const anonymousSessions = () => createSessions("/unused-anonymous-state", { profileUse });
