
## Errata (2026-10-17 live rounds)
- CHAT-3R shipped 3 post-review defects found only by live browser probes:
  (1) rails inherited flex-wrap:wrap -> sideways wrap at short viewports
  (user-reported), (2) sampling grid scrollbar collapse, (3) preset name
  row appended empty (byId stub blind spot). Plan decisions still hold.
- Preset UX round 2 (user): picker shows STATE (preset name / Modified
  (unsaved)), New/Delete buttons under the picker, inline naming,
  customPrompt stash persists on the server, rails framed.
