/**
 * A subscriber set with the two properties every store here needs: detaching
 * during dispatch takes effect immediately, and one broken subscriber does not
 * stop the rest.
 *
 * @module
 */

/** A change notification. Subscribers re-read the snapshot themselves. */
export type Listener = () => void

/** The subscriber set behind one {@link ExternalStore}. */
export class Listeners {
  readonly #listeners = new Set<Listener>()

  /**
   * Attach a subscriber.
   *
   * @param listener - called after every change.
   * @returns a function that detaches it. Idempotent.
   */
  add(listener: Listener): () => void {
    if (typeof listener !== 'function') {
      throw new TypeError('feed listener must be a function')
    }
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * Notify every current subscriber.
   *
   * @param onError - where a throwing subscriber's failure goes. The change
   *   has already happened; a broken subscriber is not a reason to pretend it
   *   did not.
   */
  emit(onError: (error: unknown) => void): void {
    for (const listener of [...this.#listeners]) {
      // Unsubscribing mid-dispatch is normal in React — an unmounting
      // component must not be told about a change it can no longer render.
      if (!this.#listeners.has(listener)) continue
      try {
        listener()
      } catch (error) {
        onError(error)
      }
    }
  }

  /** How many subscribers are attached. */
  get size(): number {
    return this.#listeners.size
  }
}
