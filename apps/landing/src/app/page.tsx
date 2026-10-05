// import { DesignPanel } from "@/components/sections/design-panel";  // hidden
import { ShaderOverlay } from "@/components/canvas/shader-overlay";
import { AgentHookup } from "@/components/sections/agent-hookup";
// import { Benchmarks } from "@/components/sections/benchmarks";  // hidden
// import { Pricing }    from "@/components/sections/pricing";   // hidden
import { ClosingCTA } from "@/components/sections/closing-cta";
import { DataStream } from "@/components/sections/data-stream";
import { FeatureGrid } from "@/components/sections/feature-grid";
import { Footer } from "@/components/sections/footer";
import { Hero } from "@/components/sections/hero";
import { Nav } from "@/components/sections/nav";
import { BlackholeProvider } from "@/context/blackhole-context";
import { CoronaProvider } from "@/context/corona-context";
import { PricingModeProvider } from "@/context/pricing-mode-context";
import { ShaderProvider } from "@/context/shader-context";

const Hr = () => <div style={{ background: "var(--xrio-border)", height: 1 }} />;

const Home = () => (
  <CoronaProvider>
    <ShaderProvider>
      <BlackholeProvider>
        <PricingModeProvider>
          {/* Hidden, not removed — the theme panel and the pricing band (plans and the
              workload estimator both) are still in the tree, just not rendered. Put the
              import and the tag back to bring either one on. */}
          {/* <DesignPanel /> */}
          <ShaderOverlay />
          <Nav />
          <main>
            <Hero />
            {/* The feature run is one block. FeatureGrid carries the page belt, the
                patch column, the format glyph and the command card, so the bands that used
                to hold them one apiece — PatchCount, Gauntlet, RuntimeRail, OutputFormats —
                are gone, and so is the Features table that repeated two of its cells.

                The pairing rule is alternation, not grouping: no two adjacent bands share a
                construction. */}
            <Hr />
            <FeatureGrid />
            <Hr />
            <DataStream />
            <Hr />
            {/* <Benchmarks />
            <Hr /> */}
            {/* <Pricing /> */}
            <AgentHookup />
            <Hr />
            <ClosingCTA />
          </main>
          <Hr />
          <Footer />
        </PricingModeProvider>
      </BlackholeProvider>
    </ShaderProvider>
  </CoronaProvider>
);

export default Home;
