/**
 * Boot the inspector.
 *
 * The feed is created here — once, outside React. The log is not owned by a
 * component, does not die with one, and is not duplicated by one.
 *
 * There is no HeroUI provider to mount: v3 dropped the `HeroUIProvider` that
 * v2/NextUI required, and its components read their theme from `data-theme` on
 * the root element instead. Which is convenient here — a provider wrapping the
 * whole tree is exactly the kind of thing that quietly widens a re-render.
 *
 * @module
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createSessionFeed } from '@harness/session-feed'
import { App } from './app.tsx'
import { FeedProvider } from './feed-context.tsx'
import './styles/app.css'

const container = document.getElementById('root')
if (container === null) throw new Error('index.html is missing #root')

const feedUrl = (import.meta.env.VITE_FEED_URL as string | undefined) ?? '/events'
const feed = createSessionFeed({ url: feedUrl })

createRoot(container).render(
  <StrictMode>
    <FeedProvider feed={feed}>
      <App />
    </FeedProvider>
  </StrictMode>,
)
