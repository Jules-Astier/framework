/** Service-wide concurrency bound with round-robin provider groups. */
export class SourceValidationQueue {
    private groups = new Map<string, Array<{ run: () => void; cancel: () => void }>>()
    private active = 0
    constructor(private concurrency: () => number) {}

    run<T>(group: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                reject(new DOMException('Source discovery was cancelled', 'AbortError'))
                return
            }
            let started = false
            const entry = {
                run: () => {
                    started = true
                    signal?.removeEventListener('abort', entry.cancel)
                    this.active++
                    Promise.resolve()
                        .then(work)
                        .then(resolve, reject)
                        .finally(() => {
                            this.active--
                            this.drain()
                        })
                },
                cancel: () => {
                    if (started) return
                    const queue = this.groups.get(group)
                    if (queue) {
                        const index = queue.indexOf(entry)
                        if (index !== -1) queue.splice(index, 1)
                        if (!queue.length) this.groups.delete(group)
                    }
                    reject(new DOMException('Source discovery was cancelled', 'AbortError'))
                },
            }
            const queue = this.groups.get(group) ?? []
            queue.push(entry)
            this.groups.set(group, queue)
            signal?.addEventListener('abort', entry.cancel, { once: true })
            this.drain()
        })
    }

    private drain(): void {
        while (this.active < this.concurrency() && this.groups.size) {
            const [group, queue] = this.groups.entries().next().value!
            this.groups.delete(group)
            const next = queue.shift()!
            if (queue.length) this.groups.set(group, queue)
            next.run()
        }
    }
}
