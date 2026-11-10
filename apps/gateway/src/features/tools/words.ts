/** Words an agent's question carries that say nothing about the tool it wants ("how do I cook rice for a crowd"). */
export const STOP = new Set(
  'a an the and or but of to in on at by for with from about into over than then that this these those is are was were be been being do does did done has have had can could should would will may might what which who whom whose when where why how i me my we our you your it its they them their he she his her some any all each every there here also just'.split(
    ' ',
  ),
)

/** Words → an FTS5 query: each meaningful word a quoted prefix, any of them matching. */
export const ftsQuery = (q: string) =>
  q
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((word) => word.length > 1 && !STOP.has(word))
    .slice(0, 12)
    .map((word) => `"${word}"*`)
    .join(' OR ')
