/** Runs `fn` over `items` with at most `concurrency` in flight at once. */
export async function mapWithConcurrency(items, concurrency, fn) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < items.length) {
            const i = nextIndex++;
            results[i] = await fn(items[i]);
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    return results;
}
