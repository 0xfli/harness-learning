import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Every test mounts its own inspector over its own feed; leaving the previous
// one in the document would let a stale subscription answer the next query.
afterEach(cleanup)
