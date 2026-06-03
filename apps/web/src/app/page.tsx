/**
 * Slice A proof-of-life page. Renders a few @roam/design components so we can confirm
 * the whole chain compiles and paints: Next 16 → token CSS vars → the ported hi-fi
 * component kit. No real screen yet — Explore is Slice B. This page gets replaced then.
 */
import { Button, Pill, Card, Rate } from "@roam/design";

export default function Home() {
  return (
    <main style={{ padding: "var(--space-8)", maxWidth: 480, margin: "0 auto" }}>
      <p
        style={{
          fontFamily: "var(--mono)",
          fontSize: 11,
          letterSpacing: ".12em",
          textTransform: "uppercase",
          color: "var(--crimson-700)",
        }}
      >
        Roam — web shell
      </p>
      <h1 className="t-display" style={{ marginBlock: "var(--space-2) var(--space-6)" }}>
        It paints.
      </h1>

      <Card style={{ padding: "var(--space-6)", display: "grid", gap: "var(--space-4)" }}>
        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
          <Pill variant="on">Browse</Pill>
          <Pill>Feed</Pill>
          <Rate value="4.6" />
        </div>
        <Button variant="pri" block>
          Primary action
        </Button>
        <Button>Secondary</Button>
      </Card>
    </main>
  );
}
