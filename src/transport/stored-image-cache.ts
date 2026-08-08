import { StoredSnapshotUnavailableError, type StoredSnapshotUnavailableReason } from "../core/contracts.js";
import type { Logger } from "../core/logger.js";

const MAX_JPEG_BYTES = 10 * 1024 * 1024;

type Candidate = {
  deviceKey: string;
  url: string;
  sequence: number;
  observedAt: number;
  generation: number;
};

type DeviceState = {
  deviceKey: string;
  nextSequence: number;
  seenUrls: Set<string>;
  loggedFailures: Map<StoredSnapshotUnavailableReason, number>;
  queued?: Candidate;
  inFlight?: Candidate;
  retained?: { sequence: number; image: Buffer };
  reason?: StoredSnapshotUnavailableReason;
  lifecycleError?: unknown;
};

const DIAGNOSTIC_INTERVAL_MS = 60_000;

/** In-memory state for push thumbnails acquired before a caller passively reads them. */
export class StoredImageCache {
  private readonly devices = new Map<string, DeviceState>();
  private readonly activeDevices = new Set<string>();
  private activeDownloads = 0;
  private generation = 0;

  constructor(
    private readonly downloader: (url: string) => Promise<Buffer>,
    private readonly logger: Logger,
    private readonly clock: () => number = Date.now,
    private readonly isLifecycleError: (error: unknown) => boolean = () => false,
  ) {}

  /** Observe a normalized thumbnail URL and start acquisition eagerly. */
  observe(deviceKey: string, url: string): void {
    let state = this.devices.get(deviceKey);
    if (!state) {
      state = {
        deviceKey,
        nextSequence: 0,
        seenUrls: new Set(),
        loggedFailures: new Map(),
      };
      this.devices.set(deviceKey, state);
    }
    if (state.seenUrls.has(url)) return;
    state.seenUrls.add(url);
    state.queued = {
      deviceKey,
      url,
      sequence: ++state.nextSequence,
      observedAt: this.clock(),
      generation: this.generation,
    };
    this.pump();
  }

  /** Return retained bytes without starting or awaiting network work. */
  snapshotStored(deviceKey: string): Promise<Buffer> {
    const state = this.devices.get(deviceKey);
    const reason = state?.queued || state?.inFlight ? "pending" : (state?.reason ?? "not-observed");
    if (reason !== "pending" && state?.lifecycleError) return Promise.reject(state.lifecycleError);
    if (state?.retained) return Promise.resolve(state.retained.image);
    return Promise.reject(new StoredSnapshotUnavailableError(reason, "No stored snapshot is available"));
  }

  /** Invalidate all retained and candidate state. */
  clear(): void {
    this.generation += 1;
    this.devices.clear();
  }

  private pump(): void {
    while (this.activeDownloads < 2) {
      const state = [...this.devices.values()].find(
        (candidateState) => candidateState.queued && !this.activeDevices.has(candidateState.deviceKey),
      );
      if (!state?.queued) return;
      const candidate = state.queued;
      state.queued = undefined;
      state.inFlight = candidate;
      this.activeDownloads += 1;
      this.activeDevices.add(candidate.deviceKey);
      void this.downloader(candidate.url).then(
        (image) => this.complete(candidate, image),
        (error: unknown) => this.complete(candidate, undefined, error),
      );
    }
  }

  private complete(candidate: Candidate, image: Buffer | undefined, error?: unknown): void {
    this.activeDownloads -= 1;
    this.activeDevices.delete(candidate.deviceKey);
    const state = this.devices.get(candidate.deviceKey);
    if (candidate.generation === this.generation && state?.inFlight === candidate) {
      state.inFlight = undefined;
      if (error !== undefined && this.isLifecycleError(error)) {
        state.lifecycleError = error;
        state.reason = undefined;
      } else if (image === undefined) {
        state.lifecycleError = undefined;
        state.reason = "download-failed";
        this.diagnose(state, candidate, "download-failed");
      } else if (!this.isValidJpeg(image)) {
        state.lifecycleError = undefined;
        state.reason = "invalid-image";
        this.diagnose(state, candidate, "invalid-image");
      } else if (!state.retained || candidate.sequence > state.retained.sequence) {
        state.retained = { sequence: candidate.sequence, image };
        state.lifecycleError = undefined;
        state.reason = undefined;
      }
    }
    this.pump();
  }

  private isValidJpeg(image: Buffer): boolean {
    return (
      Buffer.isBuffer(image) &&
      image.length > 0 &&
      image.length <= MAX_JPEG_BYTES &&
      image.length >= 5 &&
      image[0] === 0xff &&
      image[1] === 0xd8 &&
      image[2] === 0xff &&
      image[image.length - 2] === 0xff &&
      image[image.length - 1] === 0xd9
    );
  }

  private diagnose(state: DeviceState, candidate: Candidate, failure: "download-failed" | "invalid-image"): void {
    const now = this.clock();
    const last = state.loggedFailures.get(failure);
    if (last !== undefined && now - last < DIAGNOSTIC_INTERVAL_MS) return;
    state.loggedFailures.set(failure, now);
    this.logger.warn("[stored-snapshot-cache] candidate failed", {
      class: failure,
      observedAt: candidate.observedAt,
      retained: state.retained !== undefined,
    });
  }
}
