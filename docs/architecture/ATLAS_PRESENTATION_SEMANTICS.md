# Atlas Presentation Semantics

`atlas-v1/orthogonal-presentation-1` is the presentation contract for an Atlas
subject and compact local-context item. It has four independent fields:
operational state, observation freshness, Finding attention, and identity
ambiguity. None may derive, overwrite, recolour, or downgrade another.

The fixed accessible-text and marker order is identity, attention, ambiguity,
operational state, then freshness. Compact summaries may omit absent attention
and ambiguity markers, but preserve the remaining channel labels in the frozen
order: attention, ambiguity, operational state, freshness. The marker glyphs
are non-colour cues: outlined/filled triangles for advisory/warning attention,
diamond for ambiguity, fixed state shape, then freshness clock/hourglass/
slash/minus/question glyph.

A healthy subject with stale freshness remains healthy; a healthy subject with
a Finding remains healthy with warning attention; offline plus fresh remains
offline with a fresh observation; collision remains ambiguity, not a health
failure. `collecting` is not a current Atlas freshness value, so the renderer
must show the published `unknown` freshness rather than infer collection state.
Ambiguous/collision identities are non-routable in the canonical projector and
are excluded from selected local-context items rather than made to look like a
safely selectable attachment. Their uncertainty remains visible in the
directory/text alternative.
Opaque ports, evidence IDs, source refs, raw metadata, and provider labels are
not presentation inputs.
