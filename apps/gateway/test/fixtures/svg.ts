/**
 * An SVG of under 100 KB, square, that gives no usable size under `head`: librsvg then walks every shape to measure
 * it, ten thousand uses of a 40,000-step path, for half a minute or more before anything is drawn.
 */
export const sizeless = (head: string) => {
  let defs = `<path id="p" d="M0 0${'h1v1'.repeat(20_000)}"/><g id="g0">${'<use href="#p"/>'.repeat(10)}</g>`
  for (let level = 1; level <= 3; level++) defs += `<g id="g${level}">${`<use href="#g${level - 1}"/>`.repeat(10)}</g>`
  return `${head}<defs>${defs}</defs><use href="#g3"/></svg>`
}
