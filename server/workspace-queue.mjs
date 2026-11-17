export function createWorkspaceQueue(timeoutMs) {
  const queues = new Map();
  return function exclusive(key, job) {
    const previous = queues.get(key) || Promise.resolve();
    let timer;
    const timeout = new Promise((_, reject) => {
      void previous.then(() => {
        timer = setTimeout(() => {
          reject(Object.assign(new Error('workspace operation timeout'), { status: 503 }));
        }, timeoutMs);
      });
    });
    const work = previous.then(job);
    // Only the response races the deadline. Later writes wait for the real operation.
    const tail = work.then(() => {}, () => {});
    queues.set(key, tail);
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  };
}
