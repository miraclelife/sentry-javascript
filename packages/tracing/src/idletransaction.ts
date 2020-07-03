// tslint:disable: max-classes-per-file
import { Hub } from '@sentry/hub';
import { TransactionContext } from '@sentry/types';
import { logger, timestampWithMs } from '@sentry/utils';

import { Span } from './span';
import { SpanStatus } from './spanstatus';
import { SpanRecorder, Transaction } from './transaction';

const DEFAULT_IDLE_TIMEOUT = 1000;

/**
 * @inheritDoc
 */
export class IdleTransactionSpanRecorder extends SpanRecorder {
  private readonly _pushActivity: (id: string) => void;
  private readonly _popActivity: (id: string) => void;
  public transactionSpanId: string = '';

  public constructor(
    pushActivity: (id: string) => void,
    popActivity: (id: string) => void,
    transactionSpanId: string = '',
    maxlen?: number,
  ) {
    super(maxlen);
    this._pushActivity = pushActivity;
    this._popActivity = popActivity;
    this.transactionSpanId = transactionSpanId;
  }

  /**
   * @inheritDoc
   */
  public add(span: Span): void {
    // We should make sure we do not push and pop activities for
    // the transaction that this span recorder belongs to.
    if (span.spanId !== this.transactionSpanId) {
      // We patch span.finish() to pop an activity after setting an endTimestamp.
      span.finish = (endTimestamp?: number) => {
        span.endTimestamp = typeof endTimestamp === 'number' ? endTimestamp : timestampWithMs();
        this._popActivity(span.spanId);
      };

      // We should only push new activities if the span does not have an end timestamp.
      if (span.endTimestamp === undefined) {
        this._pushActivity(span.spanId);
      }
    }

    super.add(span);
  }
}

/**
 * An IdleTransaction is a transaction that automatically finishes. It does this by tracking child spans as activities.
 * You can have multiple IdleTransactions active, but if the `onScope` option is specified, the idle transaction will
 * put itself on the scope on creation.
 */
export class IdleTransaction extends Transaction {
  // Activities store a list of active spans
  // TODO: Can we use `Set()` here?
  public activities: Record<string, boolean> = {};

  // Stores reference to the timeout that calls _beat().
  private _heartbeatTimer: number = 0;

  // Track state of activities in previous heartbeat
  // TODO: If we use sets, this can just be a set, then we can do
  private _prevHeartbeatString: string | undefined;

  // Amount of times heartbeat has counted. Will cause transaction to finish after 3 beats.
  private _heartbeatCounter: number = 1;

  // The time to wait in ms until the idle transaction will be finished. Default: 1000
  private readonly _idleTimeout: number = DEFAULT_IDLE_TIMEOUT;

  // If an idle transaction should be put itself on and off the scope automatically.
  private readonly _onScope: boolean = false;

  private readonly _idleHub?: Hub;

  // We should not use heartbeat if we finished a transaction
  private _finished: boolean = false;

  private _finishCallback?: (transactionSpan: IdleTransaction) => void;

  public constructor(
    transactionContext: TransactionContext,
    hub?: Hub,
    idleTimeout: number = DEFAULT_IDLE_TIMEOUT,
    onScope: boolean = false,
  ) {
    super(transactionContext, hub);

    this._idleTimeout = idleTimeout;
    this._idleHub = hub;
    this._onScope = onScope;

    if (hub && onScope) {
      // There should only be one active transaction on the scope
      clearActiveTransaction(hub);

      // We set the transaction here on the scope so error events pick up the trace
      // context and attach it to the error.
      logger.log(`Setting idle transaction on scope. Span ID: ${this.spanId}`);
      hub.configureScope(scope => scope.setSpan(this));
    }

    // Start heartbeat so that transactions do not run forever.
    logger.log('Starting heartbeat');
    this._pingHeartbeat();
  }

  /**
   * Checks when entries of this.activities are not changing for 3 beats.
   * If this occurs we finish the transaction.
   */
  private _beat(): void {
    clearTimeout(this._heartbeatTimer);
    // We should not be running heartbeat if the idle transaction is finished.
    if (this._finished) {
      return;
    }

    const keys = Object.keys(this.activities);
    const heartbeatString = keys.length ? keys.reduce((prev: string, current: string) => prev + current) : '';

    if (heartbeatString === this._prevHeartbeatString) {
      this._heartbeatCounter++;
    } else {
      this._heartbeatCounter = 1;
    }

    this._prevHeartbeatString = heartbeatString;

    if (this._heartbeatCounter >= 3) {
      logger.log(
        `[Tracing] Transaction: ${
          SpanStatus.Cancelled
        } -> Heartbeat safeguard kicked in since content hasn't changed for 3 beats`,
      );
      this.setStatus(SpanStatus.DeadlineExceeded);
      this.setTag('heartbeat', 'failed');
      this.finishIdleTransaction(timestampWithMs());
    } else {
      this._pingHeartbeat();
    }
  }

  /**
   * Pings the heartbeat
   */
  private _pingHeartbeat(): void {
    logger.log(`ping Heartbeat -> current counter: ${this._heartbeatCounter}`);
    this._heartbeatTimer = (setTimeout(() => {
      this._beat();
    }, 5000) as any) as number;
  }

  /**
   * Finish the current active idle transaction
   */
  public finishIdleTransaction(endTimestamp: number): void {
    if (this.spanRecorder) {
      logger.log('[Tracing] finishing IdleTransaction', new Date(endTimestamp * 1000).toISOString(), this.op);

      if (this._finishCallback) {
        this._finishCallback(this);
      }

      this.spanRecorder.spans = this.spanRecorder.spans.filter((span: Span) => {
        // If we are dealing with the transaction itself, we just return it
        if (span.spanId === this.spanId) {
          return true;
        }

        // We cancel all pending spans with status "cancelled" to indicate the idle transaction was finished early
        if (!span.endTimestamp) {
          span.endTimestamp = endTimestamp;
          span.setStatus(SpanStatus.Cancelled);
          logger.log('[Tracing] cancelling span since transaction ended early', JSON.stringify(span, undefined, 2));
        }

        const keepSpan = span.startTimestamp < endTimestamp;
        if (!keepSpan) {
          logger.log(
            '[Tracing] discarding Span since it happened after Transaction was finished',
            JSON.stringify(span, undefined, 2),
          );
        }
        return keepSpan;
      });

      logger.log('[Tracing] flushing IdleTransaction');
      this.finish(endTimestamp);
    } else {
      logger.log('[Tracing] No active IdleTransaction');
    }
  }

  /**
   * @inheritDoc
   */
  public finish(endTimestamp?: number): string | undefined {
    this._finished = true;
    this.activities = {};
    // this._onScope is true if the transaction was previously on the scope.
    if (this._onScope) {
      clearActiveTransaction(this._idleHub);
    }
    return super.finish(endTimestamp);
  }

  /**
   * Start tracking a specific activity.
   * @param spanId The span id that represents the activity
   */
  private _pushActivity(spanId: string): void {
    logger.log(`[Tracing] pushActivity: ${spanId}`);
    this.activities[spanId] = true;
    logger.log('[Tracing] new activities count', Object.keys(this.activities).length);
  }

  /**
   * Remove an activity from usage
   * @param spanId The span id that represents the activity
   */
  private _popActivity(spanId: string): void {
    if (this.activities[spanId]) {
      logger.log(`[Tracing] popActivity ${spanId}`);
      // tslint:disable-next-line: no-dynamic-delete
      delete this.activities[spanId];
      logger.log('[Tracing] new activities count', Object.keys(this.activities).length);
    }

    if (Object.keys(this.activities).length === 0) {
      const timeout = this._idleTimeout;
      // We need to add the timeout here to have the real endtimestamp of the transaction
      // Remember timestampWithMs is in seconds, timeout is in ms
      const end = timestampWithMs() + timeout / 1000;

      setTimeout(() => {
        if (!this._finished) {
          this.finishIdleTransaction(end);
        }
      }, timeout);
    }
  }

  /**
   * Register a callback function that gets excecuted before the transaction finishes.
   * Useful for cleanup or if you want to add any additional spans based on current context.
   *
   * This is exposed because users have no other way of running something before an idle transaction
   * finishes.
   */
  public beforeFinish(callback: (transactionSpan: IdleTransaction) => void): void {
    this._finishCallback = callback;
  }

  /**
   * @inheritDoc
   */
  public initSpanRecorder(maxlen?: number): void {
    if (!this.spanRecorder) {
      const pushActivity = (id: string) => {
        if (id !== this.spanId) {
          this._pushActivity(id);
        }
      };
      const popActivity = (id: string) => {
        if (id !== this.spanId) {
          this._popActivity(id);
        }
      };
      this.spanRecorder = new IdleTransactionSpanRecorder(pushActivity, popActivity, this.spanId, maxlen);
    }
    this.spanRecorder.add(this);
  }
}

/**
 * Reset active transaction on scope
 */
function clearActiveTransaction(hub?: Hub): void {
  if (hub) {
    const scope = hub.getScope();
    if (scope) {
      const transaction = scope.getTransaction();
      if (transaction) {
        scope.setSpan(undefined);
      }
    }
  }
}
