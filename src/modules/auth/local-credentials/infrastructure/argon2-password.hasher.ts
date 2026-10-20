import argon2 from 'argon2';

import { AppError } from '@/common/errors/app-error';
import {
  recordArgon2QueueRefusal,
  recordArgon2QueueWait,
} from '@/common/observability/metrics';
import { ARGON2ID_PARAMETERS } from '@/modules/auth/local-credentials/application/argon2id-parameters';
import type { PasswordHasherPort } from '@/modules/auth/local-credentials/application/password-hasher.port';

export const ARGON2ID_OPTIONS = Object.freeze({
  type: argon2.argon2id,
  ...ARGON2ID_PARAMETERS,
});

const MAX_QUEUED_ARGON2_OPERATIONS = 8;
const MAX_ARGON2_QUEUE_WAIT_MS = 1000;
const ARGON2_RETRY_AFTER_MS = 1000;

interface Argon2Waiter {
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: AppError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Argon2PasswordHasher implements PasswordHasherPort {
  private active = 0;
  private readonly queue: Argon2Waiter[] = [];

  constructor(private readonly maxConcurrency = 2) {}

  async hash(password: string): Promise<string> {
    const release = await this.acquire();
    try {
      return await argon2.hash(password, ARGON2ID_OPTIONS);
    } finally {
      release();
    }
  }

  async verify(password: string, encodedHash: string): Promise<boolean> {
    const release = await this.acquire();
    try {
      return await argon2.verify(encodedHash, password);
    } catch {
      return false;
    } finally {
      release();
    }
  }

  private acquire(): Promise<() => void> {
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return Promise.resolve(() => this.release());
    }
    if (this.queue.length >= MAX_QUEUED_ARGON2_OPERATIONS) {
      recordArgon2QueueRefusal();
      return Promise.reject(this.capacityError());
    }

    recordArgon2QueueWait();
    return new Promise((resolve, reject) => {
      const waiter: Argon2Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.queue.indexOf(waiter);
          if (index < 0) return;
          this.queue.splice(index, 1);
          recordArgon2QueueRefusal();
          reject(this.capacityError());
        }, MAX_ARGON2_QUEUE_WAIT_MS),
      };
      waiter.timer.unref?.();
      this.queue.push(waiter);
    });
  }

  private release(): void {
    const waiter = this.queue.shift();
    if (waiter !== undefined) {
      clearTimeout(waiter.timer);
      waiter.resolve(() => this.release());
      return;
    }
    this.active -= 1;
  }

  private capacityError(): AppError {
    return new AppError({
      code: 'AUTH_ARGON2_CAPACITY',
      message: 'Authentication capacity is temporarily unavailable',
      retryable: true,
      retryAfterMs: ARGON2_RETRY_AFTER_MS,
      retryAfterHeader: true,
    });
  }
}
