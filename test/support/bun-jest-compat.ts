const bunJest = jest as unknown as {
  mocked?: <T>(source: T) => jest.Mocked<T>;
  advanceTimersByTime: (milliseconds: number) => void;
  advanceTimersByTimeAsync?: (milliseconds: number) => Promise<void>;
};

if (bunJest.mocked === undefined) {
  bunJest.mocked = <T>(source: T): jest.Mocked<T> => source as jest.Mocked<T>;
}

bunJest.advanceTimersByTimeAsync ??= async (milliseconds: number) => {
  // shortcut: step gaps up to 1s; bulk-advance longer gaps and flush 20 turns.
  for (let turn = 0; turn < 20; turn += 1) {
    await Promise.resolve();
  }
  if (milliseconds > 1_000) {
    bunJest.advanceTimersByTime(milliseconds);
  } else {
    for (let elapsed = 0; elapsed < milliseconds; elapsed += 1) {
      bunJest.advanceTimersByTime(1);
      await Promise.resolve();
    }
  }
  for (let turn = 0; turn < 20; turn += 1) {
    await Promise.resolve();
  }
};
