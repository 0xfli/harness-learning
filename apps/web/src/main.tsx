/**
 * Boot the inspector.
 *
 * The feed is created here — once, outside React. The log is not owned by a
 * component, does not die with one, and is not duplicated by one. The write
 * half is built here for the same reason, and kept separate from the feed:
 * replicating the log and adding to it are different jobs.
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
import { createExchangeClient } from './exchange-client.ts'
import { ExchangeProvider } from './exchange-context.tsx'
import { FeedProvider } from './feed-context.tsx'
import './styles/app.css'

const container = document.getElementById('root')
if (container === null) throw new Error('index.html is missing #root')

const feedUrl = (import.meta.env.VITE_FEED_URL as string | undefined) ?? '/events'
const feed = createSessionFeed({ url: feedUrl })
const messagesUrl = (import.meta.env.VITE_MESSAGES_URL as string | undefined) ?? '/messages'
const startExchange = createExchangeClient({ url: messagesUrl })

createRoot(container).render(
  <StrictMode>
    <FeedProvider feed={feed}>
      <ExchangeProvider start={startExchange}>
        <App />
      </ExchangeProvider>
    </FeedProvider>
  </StrictMode>,
)
