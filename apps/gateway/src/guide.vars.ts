/**
 * The guide's own variables, beside the parts the kit generates. The kit reads every `{{word}}` in `guide/` as a
 * placeholder, and a test fails on one nothing fills, so a `{{name}}` meant to be read as written is written
 * `{{open}}name}}`: `open` is filled with `{{` and the rest is left as it is.
 */
export const GUIDE_VARS = { open: '{{' }
