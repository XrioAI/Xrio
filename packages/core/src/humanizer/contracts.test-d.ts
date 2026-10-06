import { describe, expectTypeOf, it } from "vite-plus/test";

import type { GlPersonaKind, GpuChoice } from "./contracts.ts";

describe("GpuChoice types", () => {
  it("holds a hide-only persona over SwiftShader, a hardware one on a native GPU, or none on either", () => {
    expectTypeOf<{
      readonly backend: "swiftshader";
      readonly persona: { readonly kind: "hide-only"; readonly name: string };
    }>().toExtend<GpuChoice>();
    expectTypeOf<{
      readonly backend: "native";
      readonly persona: { readonly kind: "hardware"; readonly name: string };
    }>().toExtend<GpuChoice>();
    expectTypeOf<{ readonly backend: "native"; readonly persona: null }>().toExtend<GpuChoice>();
    expectTypeOf<{
      readonly backend: "swiftshader";
      readonly persona: null;
    }>().toExtend<GpuChoice>();
  });

  it("cannot hold a hardware persona over SwiftShader, nor a hide-only one on a native GPU", () => {
    expectTypeOf<{
      readonly backend: "swiftshader";
      readonly persona: { readonly kind: "hardware"; readonly name: string };
    }>().not.toExtend<GpuChoice>();
    expectTypeOf<{
      readonly backend: "native";
      readonly persona: { readonly kind: "hide-only"; readonly name: string };
    }>().not.toExtend<GpuChoice>();
    expectTypeOf<{
      readonly backend: GpuChoice["backend"];
      readonly persona: { readonly kind: GlPersonaKind; readonly name: string };
    }>().not.toExtend<GpuChoice>();
    expectTypeOf<{ readonly backend: "native" }>().not.toExtend<GpuChoice>();
  });

  it("holds a hardware persona over SwiftShader only with the announce policy", () => {
    expectTypeOf<{
      readonly backend: "swiftshader";
      readonly persona: { readonly kind: "hardware"; readonly name: string };
      readonly policy: "announce";
    }>().toExtend<GpuChoice>();
    expectTypeOf<{
      readonly backend: "swiftshader";
      readonly persona: { readonly kind: "hardware"; readonly name: string };
      readonly policy: "matched";
    }>().not.toExtend<GpuChoice>();
    expectTypeOf<{
      readonly backend: "swiftshader";
      readonly persona: { readonly kind: "hardware"; readonly name: string };
      readonly policy: "announce" | "matched";
    }>().not.toExtend<GpuChoice>();
  });

  it("never tags a choice that holds no persona, a hide-only persona or a native GPU with the policy", () => {
    expectTypeOf<{
      readonly backend: "swiftshader";
      readonly persona: null;
      readonly policy: "announce";
    }>().not.toExtend<GpuChoice>();
    expectTypeOf<{
      readonly backend: "swiftshader";
      readonly persona: { readonly kind: "hide-only"; readonly name: string };
      readonly policy: "announce";
    }>().not.toExtend<GpuChoice>();
    expectTypeOf<{
      readonly backend: "native";
      readonly persona: { readonly kind: "hardware"; readonly name: string };
      readonly policy: "announce";
    }>().not.toExtend<GpuChoice>();
    expectTypeOf<{
      readonly backend: "native";
      readonly persona: null;
      readonly policy: "announce";
    }>().not.toExtend<GpuChoice>();
  });
});
