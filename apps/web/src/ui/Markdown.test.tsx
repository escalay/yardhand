import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Markdown } from './Markdown'

afterEach(cleanup)

describe('Markdown', () => {
  it('shows an image as a link to it, so opening the text fetches nothing', () => {
    const { container } = render(
      <Markdown>
        {'Done.\n\n![a pixel](https://elsewhere.example/p.png?v=desk)\n\n<img src="https://elsewhere.example/q.png">'}
      </Markdown>,
    )
    expect(container.querySelector('img')).toBeNull()
    const link = screen.getByRole('link', { name: 'Image: a pixel' })
    expect(link.getAttribute('href')).toBe('https://elsewhere.example/p.png?v=desk')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  })
})
