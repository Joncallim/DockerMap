import type { JSX } from "react";
import { HybridAtlas } from "./HybridAtlas";
import { NativeSvgAtlas } from "./NativeSvgAtlas";
import type { AtlasRendererCandidate } from "./policy";
import type { AtlasRendererProps } from "./shared";

/** Test-only mount point. It is intentionally not exported from any product route. */
export function RendererHarness({ candidate, ...props }: AtlasRendererProps & { candidate: AtlasRendererCandidate }): JSX.Element {
  return candidate === "native_svg" ? <NativeSvgAtlas {...props} /> : <HybridAtlas {...props} />;
}
