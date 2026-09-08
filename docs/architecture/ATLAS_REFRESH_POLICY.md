# Atlas Refresh and Viewport Policy

Status: prospective policy for #269. This policy describes the required Atlas
refresh behavior; it does not add a topology fact or authorize a second data
source. `INFRASTRUCTURE_ATLAS.md` remains authoritative for source authority,
projection, identity, and logical layout.

## One coherent revision at a time

Atlas consumes the already-published `useSystemModel` result through the single
outer `AtlasEnvelope`. It never starts an Atlas-specific fetch and it never
joins a snapshot, runtime map, findings response, Compose response, or graph
response in the screen or renderer. A screen replaces its semantic model and
logical layout only when that coherent publication changes. It must not render
an old layout with a new model, a new layout with old markers, or a partially
settled intermediate layout.

The deterministic `AtlasModel` and `AtlasLayout` remain revision-free. The
outer source revision decides whether a live publication may replace the prior
one; timestamps and refresh cadence do not enter semantic ordering or logical
coordinates.

## Revision classes

| Coherent change | Required result |
| --- | --- |
| Operational state, freshness, or matching Finding attention only | Update the independent marker/text channels. Every surviving logical anchor and the viewport transform remain exact. |
| Relation or attachment only | Keep subject anchors and viewport exact. Only the documented local relation/attachment disclosure or aggregate can change. |
| Add/remove in a local lane/region | Apply the fresh deterministic layout atomically. Existing unrelated lanes/anchors retain their published positions; an added subject occupies its deterministic local slot. |
| Selected identity remains exact and routable | Preserve selection and its local inspection state. |
| Selected identity is removed, unresolved, or collided | Fail closed: remove selection, show the existing unavailable status, and recover keyboard focus to the directory. Do not select a lookalike. |

Removed subjects disappear with their replacement revision. Atlas has no physics
settling, animated flow, or decorative removal motion; such motion would imply
causal or temporal evidence that the model does not publish.

## Camera and framing

`ATLAS_CAMERA_POLICY` (`atlas-v1/refresh-camera-1`) separates camera state from
semantic topology. Initial entry uses the one deterministic `{ x: 0, y: 0,
zoom: 1 }` framing. The screen stores that framing independently from the
current envelope, so state-only, relation-only, attachment-only, unrelated
structural, and same-context lens revisions cannot auto-fit, recenter, or
otherwise mutate it.

The current overview exposes no pan, zoom, Reset, Fit, or whole-host refit
control. A future interaction change may add an explicit user-initiated
Reset/Fit or a bounded `ensure-visible` operation for an exact selected target;
it must not make either behavior an automatic refresh response. It must also
preserve the camera when a lens retains the same canonical context. Camera
coordinates are never URL state, local-storage state, or semantic/layout input.

Home preview framing is independently derived from canonical logical bounds
when that preview exists; it is not durable Atlas camera state. Browser resize
may clamp presentation or ensure an already-selected target is visible, but it
must not rewrite canonical subject coordinates or silently persist a new camera
transform.

## Density, theme, and test gates

Theme never changes logical coordinates, lane assignment, canonical order, or
camera transform. Application density may alter surrounding directory and
inspector spacing, but it must not globally reflow Atlas topology; subject
anchor centers and connector routing inputs stay fixed. Renderer geometry tests
must separately assert logical-anchor displacement and screen-space displacement
from camera changes. A pass for one is not evidence for the other.

The focused Atlas tests cover the coherent-only screen input, exact anchor
stability for state/relation/unrelated structural revisions, exact viewport
transform preservation across those classes, survival of an exact selected key,
and fail-closed selection recovery. No refresh path may add a dependency,
query-controlled camera state, local-storage state, animation, or an
independent API request.
