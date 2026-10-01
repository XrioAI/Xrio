# Xrio landing page

The Next.js app is now `@xrio/landing` in `apps/landing`. This migration imports
`proxidize/xrio-landing-page` main at `9d94102`, including its WebGPU hero, Three.js
option (`?hero=three`), and Canvas 2D fallback. Pricing and the design panel remain
in the source but are deliberately hidden in `page.tsx`.

## Local development

Use Node.js 24+ and [Vite+](https://viteplus.dev/guide/). Run from the monorepo root:

```sh
vp install
vp run web:dev
```

Open the URL printed by Next.js (normally http://localhost:3000; another port is
chosen if it is occupied). Edit `apps/landing/src/app/page.tsx` and its components.

Vite+ uses the root's pinned pnpm version. Dependencies belong in the app's
`package.json`; the workspace has one root `pnpm-lock.yaml`:

```sh
vp add --filter @xrio/landing package-name
vp add --filter @xrio/landing -D package-name
```

Commit the manifest and root lockfile together. Shared code can live in `packages/`
and be consumed through a `workspace:*` dependency when another app needs it.

## Checks

The app uses the root Oxlint/Oxfmt configuration with Ultracite's React and Next.js
presets. Filenames are kebab-case (for example `pricing.tsx`), while component names
remain PascalCase. Rules also cover accessibility, React hooks, unsafe types,
unhandled promises, and function complexity. Use the repository's existing
configuration for all apps.

```sh
vp fmt apps/landing                     # Format only
vp check                              # Format check, lint, and type-aware checks
vp run fix                            # Format and apply safe lint fixes
vp run --filter @xrio/landing typecheck # Next route types and app TypeScript
vp run ready                          # All workspace checks and tests
vp run --filter @xrio/landing build
vp run --filter @xrio/landing start
```

For case-only renames on macOS, use an intermediate filename with `git mv`, and
restart the editor's lint server if a diagnostic still names the old casing.

The `.wgsl` shader loader and GPU types are direct app dependencies for pnpm's
strict resolution. Browser WebGPU does not need the server GPU packages' install
scripts. The build downloads Google fonts, so it needs network access.

## Docker

Build from the monorepo root, so pnpm can read the workspace lockfile and patches:

```sh
docker build -f apps/landing/Dockerfile -t xrio-landing .
docker run --rm -p 3000:3000 xrio-landing
```

The runtime image contains Next.js standalone output, static assets, and `public/`.
It runs as the `node` user and listens on `0.0.0.0:$PORT` (default 3000).
