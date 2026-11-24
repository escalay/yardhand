// Yardhand's brand on every surface the kit serves. Edit it or icon.svg (the app's own mark,
// apps/web/public/favicon.svg), then `npx @escalay/kit brand` renders src/brand.gen.ts again.
import { defineBrand } from '../src/kit/brand/index.js'

export default defineBrand({
  name: 'yardhand',
  title: 'Yardhand',
  description: 'A self-hosted gateway: one endpoint for every tool, over MCP and REST, with credentials kept once.',
  websiteUrl: 'https://github.com/escalay/yardhand',
  // The app's signal blue (--color-primary in apps/web/src/styles.css), and the mark's own graphite ground
  accent: '#006ad9',
  background: '#111428',
})
