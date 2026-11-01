export class Singleflight<K, V> {
  private readonly flights = new Map<K, Promise<V>>();

  run(key: K, work: () => Promise<V>): Promise<V> {
    const existing = this.flights.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const flight = Promise.resolve().then(work);
    this.flights.set(key, flight);
    void flight.then(
      () => this.remove(key, flight),
      () => this.remove(key, flight),
    );
    return flight;
  }

  private remove(key: K, flight: Promise<V>): void {
    if (this.flights.get(key) === flight) {
      this.flights.delete(key);
    }
  }
}
