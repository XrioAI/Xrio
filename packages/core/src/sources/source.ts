import { createBrowsers } from "./browser/browsers.ts";
import type { RetireSteps } from "./browser/chrome-scope.ts";
import type { BrowserDriver } from "./browser/port.ts";
import { loadHttpDocument } from "./http.ts";
import type { Sources } from "./visit.ts";

export const createSources = (
  driver: BrowserDriver,
  retire: Partial<RetireSteps> = {},
): Sources => {
  const browsers = createBrowsers(driver, retire);

  return {
    close: browsers.close,
    start: (plan, slot, deadline) => {
      if (plan.kind === "browser") {
        return browsers.start(plan, slot, deadline);
      }

      const load = async () => {
        slot.assertHeld();
        deadline.throwIfExpired();

        return await loadHttpDocument(plan, deadline);
      };

      const document = load();

      const closing = async () => {
        await Promise.allSettled([document]);

        return { exited: true } as const;
      };

      return { closed: closing(), document };
    },
  };
};
