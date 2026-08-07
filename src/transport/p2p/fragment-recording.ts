import { EventEmitter } from "node:events";
import type { FragmentRecordingHandle, MediaFragment, StreamBudgetNotice } from "../../core/contracts.js";
import { Fmp4Muxer } from "./fmp4.js";
import type { Consumer, SharedLiveSource, TimedMediaFrame } from "./shared-live-source.js";

export interface FragmentRecordingOptions {
  fragmentSeconds?: number;
  preBufferSeconds?: number;
}

/**
 * One caller-owned fragmented recording over a shared live source. Buffered and live frames pass
 * through the same timestamp-aware muxer, while budget notices retain the source's `extend()` handle.
 */
export class FragmentRecording extends EventEmitter implements FragmentRecordingHandle {
  private readonly mux: Fmp4Muxer;
  private readonly queue: MediaFragment[] = [];
  private consumer?: Consumer;
  private wake?: () => void;
  private failure?: Error;
  private ended = false;
  private iterated = false;
  private readonly ready: Promise<void>;

  constructor(
    source: Promise<SharedLiveSource>,
    private readonly opts: FragmentRecordingOptions = {},
  ) {
    super();
    this.mux = new Fmp4Muxer({ fragmentSeconds: opts.fragmentSeconds, audio: true });
    this.ready = this.attach(source);
  }

  override on(event: "budget", listener: (notice: StreamBudgetNotice) => void): this;
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  stop(): void {
    if (this.ended) return;
    const tail = this.mux.flush();
    if (tail) this.queue.push(tail);
    this.ended = true;
    this.consumer?.detach();
    this.nudge();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<MediaFragment> {
    if (this.iterated) throw new Error("fragment recording can be consumed only once");
    this.iterated = true;
    try {
      await this.ready;
      for (;;) {
        if (this.queue.length) {
          yield this.queue.shift()!;
          continue;
        }
        if (this.failure) throw this.failure;
        if (this.ended) return;
        await new Promise<void>((resolve) => (this.wake = resolve));
      }
    } finally {
      this.stop();
    }
  }

  private async attach(sourcePromise: Promise<SharedLiveSource>): Promise<void> {
    try {
      const source = await sourcePromise;
      if (this.ended) return;
      const attached = source.attachWithPrebuffer(this.opts.preBufferSeconds ?? 0);
      this.consumer = attached.consumer;
      this.consumer.onMedia((item) => this.ingest(item));
      this.consumer.on("budget", (notice) => this.emit("budget", notice));
      this.consumer.on("stop", () => this.stop());
      this.consumer.on("error", (error) => this.fail(error));
      for (const item of attached.buffered) this.ingest(item);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private ingest(item: TimedMediaFrame): void {
    if (this.ended) return;
    try {
      const fragment =
        item.kind === "video"
          ? this.mux.push(item.frame, item.timestampMs)
          : this.mux.pushAudio(item.frame, item.timestampMs);
      if (fragment) this.queue.push(fragment);
      this.nudge();
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private fail(error: Error): void {
    if (this.ended) return;
    this.failure = error;
    this.ended = true;
    this.consumer?.detach();
    this.nudge();
  }

  private nudge(): void {
    this.wake?.();
    this.wake = undefined;
  }
}
