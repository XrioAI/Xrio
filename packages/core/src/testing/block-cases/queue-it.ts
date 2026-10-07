import type { BlockCase } from "../block-cases.ts";

export const queueItCases = {
  tp_queueit_waiting_room: {
    cookies: [
      "QueueITAccepted-SDFrts345E-V3_arena=REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; Path=/",
    ],
    expect: {
      decoys: [],
      page: "interstitial_with_prose",
      passedChallenges: [],
      ruleIds: ["queue_it_waiting_room"],
      vendor: "queue-it",
      verdict: "queued",
    },
    headers: { "content-type": "text/html; charset=utf-8", server: "Microsoft-IIS/10.0" },
    html: `<!DOCTYPE html><html lang="en"><head><title>You are in line — Example Arena</title></head>
<body>
<main>
<h1>You are now in line</h1>
<p>Thanks for your patience. Your place in line is reserved and this page will move you forward
automatically when it is your turn. Please do not refresh or close this window, and do not open the
shop in a second tab: both will send you to the back of the queue.</p>
<p>Estimated wait: 6 minutes. People ahead of you: 1,842.</p>
</main>
<script src="https://static.queue-it.net/script/queueclient.min.js"></script>
</body></html>
`,
    requestUrls: [
      "https://tickets.arena.example/checkout",
      "https://exampleArena.queue-it.net/?c=examplearena&e=summer2026",
      "https://static.queue-it.net/script/queueclient.min.js",
    ],
    status: 200,
    url: "https://exampleArena.queue-it.net/?c=examplearena&e=summer2026&REDACTEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx&cid=en-GB",
    why: "A Queue-it waiting room is queued, not blocked, by its final host.",
  },
} satisfies Record<string, BlockCase>;
