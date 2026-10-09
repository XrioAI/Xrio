<!-- DEEP MODULES START -->

# Deep Modules and Outcome-Oriented Naming

Prefer deep modules: keep substantial implementation complexity behind a small, clear interface.

Write orchestration so it reads from top to bottom like domain prose. Each step should stay at the same level of abstraction and describe the next meaningful outcome. A reader should understand the workflow without inspecting each step’s implementation.

Name operations after what they produce or make true, rather than the low-level mechanism they use.

- Keep callers focused on intent; hide implementation dependencies.
- Extract reusable workflow steps behind clear boundaries when doing so improves readability or avoids duplication.
- Keep essential invariants inside the boundary that owns them so every caller receives them automatically.

<!-- DEEP MODULES END -->

# Client release notes

When changing `packages/core`, follow [.agents/skills/changeset/SKILL.md](.agents/skills/changeset/SKILL.md) before finishing the task.

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

<!-- ULTRACITE START -->

# Ultracite Code Standards

This project uses Ultracite with Oxlint and Oxfmt. The active presets are Ultracite core, Vitest, anti-slop, and cognitive complexity.

## Quick Reference

- Format and safely fix code: `vp check --fix`
- Check formatting, lint rules, and types: `vp check`
- Run tests: `vp test`
- Diagnose the standalone Ultracite setup: `vp exec ultracite doctor`

## Core Principles

Write code that is accessible, performant, type-safe, and maintainable. Favor clarity and explicit intent over brevity.

### Type Safety and Explicitness

- Use explicit parameter and return types when they improve clarity.
- Prefer `unknown` over `any` when a value is genuinely unknown, then parse or narrow it into a named domain type at the boundary.
- Prefer type narrowing over type assertions. Every necessary `as` assertion must have a nearby `SAFETY:` comment stating the checked invariant.
- Use `as const` for immutable values and literal types.
- Use meaningful names instead of magic numbers; extract descriptive constants.
- Avoid chained assertions, widening a known value and asserting it back, `Reflect`-based property access, and shape-encoded symbol names.

### Modern JavaScript and TypeScript

- Use arrow functions for callbacks and short functions.
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops.
- Use optional chaining and nullish coalescing for nullable values.
- Prefer template literals over string concatenation.
- Use destructuring for object and array assignments.
- Use `const` by default, `let` only for reassignment, and never `var`.

### Async and Promises

- Await promises in async functions and use or explicitly return their values.
- Prefer `async`/`await` over promise chains when it improves readability.
- Handle errors deliberately; do not catch an error only to rethrow it.
- Never use an async function as a Promise executor.

### Error Handling and Debugging

- Remove `console.log`, `debugger`, and `alert` from production code.
- Throw descriptive `Error` objects, not strings or arbitrary values.
- Prefer early returns over deeply nested error branches.

### Code Organization

- Keep functions focused and at or below cognitive complexity 15.
- Extract complex conditions into well-named boolean variables.
- Prefer early returns and simple conditionals over nested ternaries.
- Group related code and separate responsibilities.
- Avoid barrel files that only re-export other modules.

### Testing

- Put assertions inside `test()` or `it()` blocks.
- Use `async`/`await` rather than done callbacks.
- Do not commit `.only` or `.skip` tests.
- Keep test suites reasonably flat.
- Inject dependencies instead of mocking whole modules; anti-slop rejects module mocking by default.

### Security and Performance

- Validate and sanitize untrusted input.
- Never use `eval()` or assign directly to `document.cookie`.
- Avoid spread syntax in loop accumulators.
- Hoist regular-expression literals out of loops.
- Prefer specific imports over namespace imports.

## What Automated Checks Cannot Decide

Review business logic, naming, architecture, edge cases, user experience, and documentation deliberately. Oxlint and Oxfmt can enforce mechanics, but they cannot validate product intent.

<!-- ULTRACITE END -->
