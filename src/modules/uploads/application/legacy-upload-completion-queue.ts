// ponytail: Avatar and Writing serialize same-asset retries within one process until their repositories own that behavior (#1732).
export class LegacyUploadCompletionQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, complete: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(key) ?? Promise.resolve()).then(complete);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
