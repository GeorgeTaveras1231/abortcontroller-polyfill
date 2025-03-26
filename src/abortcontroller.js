import { createAbortEvent, normalizeAbortReason } from './abortsignal-ponyfill';

class Emitter {
  constructor() {
    Object.defineProperty(this, 'listeners', { value: {}, writable: true, configurable: true });
  }
  addEventListener(type, callback, options) {
    if (!(type in this.listeners)) {
      this.listeners[type] = [];
    }
    this.listeners[type].push({ callback, options });
  }
  removeEventListener(type, callback) {
    if (!(type in this.listeners)) {
      return;
    }
    const stack = this.listeners[type];
    for (let i = 0, l = stack.length; i < l; i++) {
      if (stack[i].callback === callback) {
        stack.splice(i, 1);
        return;
      }
    }
  }
  dispatchEvent(event) {
    if (!(event.type in this.listeners)) {
      return;
    }
    const stack = this.listeners[event.type];
    const stackToCall = stack.slice();
    for (let i = 0, l = stackToCall.length; i < l; i++) {
      const listener = stackToCall[i];
      try {
        listener.callback.call(this, event);
      } catch (e) {
        Promise.resolve().then(() => {
          throw e;
        });
      }
      if (listener.options && listener.options.once) {
        this.removeEventListener(event.type, listener.callback);
      }
    }
    return !event.defaultPrevented;
  }
}

const supportsEventTarget = typeof EventTarget !== 'undefined';
const EventTargetClass = supportsEventTarget ? EventTarget : Emitter;

const createWeakRef = (value) => {
  if (typeof WeakRef !== 'undefined') {
    return new WeakRef(value);
  }
  return { deref: () => value };
};

let symbolId = 0;
const symbolStamp = Math.random() * 99999;
const createSymbol = (name) => {
  return typeof Symbol !== 'undefined' ? Symbol(name) : `__Symbol_${symbolStamp}_${symbolId++}__`;
};

const createWeakMap = () => {
  if (typeof WeakMap !== 'undefined') {
    return new WeakMap();
  }
  const symbol = createSymbol('WeakMap');

  return {
    get: (key) => key[symbol],
    set: (key, value) => {
      Object.defineProperty(key, symbol, {
        enumerable: false,
        configurable: true,
        value,
        writable: true,
      });
    },
    delete: (key) => { delete key[symbol]; },
  };
};
const createFinalizationRegistry = (cleanupCallback) => {
  if (typeof FinalizationRegistry !== 'undefined') {
    return new FinalizationRegistry(cleanupCallback);
  }
  return { register: () => { }, unregister: () => { } };
};

class IterableWeakSet {
  constructor() {
    this._head = null;
    this._tail = null;
    this._finalizationRegistry = createFinalizationRegistry((node) => this._deleteNode(node));
    this._nodes = createWeakMap();
  }

  clear() {
    let node = this._head;
    while (node) {
      this._finalizationRegistry.unregister(node.value.deref());
      node = node.next;
    }
    this._head = null;
    this._tail = null;
    this._nodes = createWeakMap();
  }
  add(value) {
    const node = { value: createWeakRef(value), next: null, prev: null };
    if (!this._head) {
      this._head = node;
      this._tail = node;
    } else {
      this._tail.next = node;
      node.prev = this._tail;
      this._tail = node;
    }
    this._nodes.set(value, node);
    this._finalizationRegistry.register(value, node);
  }

  delete(value) {
    const node = this._nodes.get(value);
    if (!node) return;
    this._deleteNode(node);
  }

  _deleteNode(node) {
    this._nodes.delete(node);
    const value = node.value.deref();
    if (value) {
      this._finalizationRegistry.unregister(value);
    }
    if (node === this._head) {
      node.next.prev = null;
      this._head = node.next;
    } else if (node === this._tail) {
      node.prev.next = null;
      this._tail = node.prev;
    } else {
      const prev = node.prev;
      const next = node.next;
      prev.next = next;
      next.prev = prev;
    }
  }
  toArray() {
    const result = [];
    let node = this._head;
    while (node) {
      const value = node.value.deref();
      if (value) {
        result.push(value);
      } else {
        this._deleteNode(node);
      }
      node = node.next;
    }
    return result;
  }
}


const controllerSymbol = createSymbol('AbortController');
const anySignalsSymbol = createSymbol('AbortSignal.any');


/**
 * @this AbortSignal
 */
function abortAnySignals() {
  const anySignals = this[anySignalsSymbol].toArray();

  for (const signal of anySignals) {
    const controller = signal[controllerSymbol];
    controller.abort(this.reason);
  }
  this[anySignalsSymbol].clear();
  this.removeEventListener('abort', abortAnySignals);
}

export class AbortSignal extends EventTargetClass {
  constructor() {
    super();
    // Some versions of babel does not transpile super() correctly for IE <= 10, if the parent
    // constructor has failed to run, then "this.listeners" will still be undefined and then we call
    // the parent constructor directly instead as a workaround. For general details, see babel bug:
    // https://github.com/babel/babel/issues/3041
    // This hack was added as a fix for the issue described here:
    // https://github.com/Financial-Times/polyfill-library/pull/59#issuecomment-477558042
    if (!this.listeners && !supportsEventTarget) {
      EventTargetClass.call(this);
    }

    // Compared to assignment, Object.defineProperty makes properties non-enumerable by default and
    // we want Object.keys(new AbortController().signal) to be [] for compat with the native impl
    Object.defineProperty(this, 'aborted', { value: false, writable: true, configurable: true });
    Object.defineProperty(this, 'onabort', { value: null, writable: true, configurable: true });
    Object.defineProperty(this, 'reason', { value: undefined, writable: true, configurable: true });

    Object.defineProperty(this, anySignalsSymbol, { value: new IterableWeakSet(), writable: false, configurable: false, enumerable: false });
  }
  toString() {
    return '[object AbortSignal]';
  }
  dispatchEvent(event) {
    if (event.type === 'abort') {
      this.aborted = true;
      if (typeof this.onabort === 'function') {
        this.onabort.call(this, event);
      }

      abortAnySignals.call(this);
    }

    super.dispatchEvent(event);
  }

  /**
   * @see {@link https://developer.mozilla.org/zh-CN/docs/Web/API/AbortSignal/throwIfAborted}
   */
  throwIfAborted() {
    const { aborted, reason = 'Aborted' } = this;

    if (!aborted) return;

    throw reason;
  }

  /**
   * @see {@link https://developer.mozilla.org/zh-CN/docs/Web/API/AbortSignal/timeout_static}
   * @param {number} time The "active" time in milliseconds before the returned {@link AbortSignal} will abort.
   *                      The value must be within range of 0 and {@link Number.MAX_SAFE_INTEGER}.
   * @returns {AbortSignal} The signal will abort with its {@link AbortSignal.reason} property set to a `TimeoutError` {@link DOMException} on timeout,
   *                        or an `AbortError` {@link DOMException} if the operation was user-triggered.
   */
  static timeout(time) {
    const controller = new AbortController();

    setTimeout(() => controller.abort(new DOMException(`This signal is timeout in ${time}ms`, 'TimeoutError')), time);

    return controller.signal;
  }

  /**
   * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/any_static}
   * @param {Iterable<AbortSignal>} iterable An {@link Iterable} (such as an {@link Array}) of abort signals.
   * @returns {AbortSignal} - **Already aborted**, if any of the abort signals given is already aborted.
   *                          The returned {@link AbortSignal}'s reason will be already set to the `reason` of the first abort signal that was already aborted.
   *                        - **Asynchronously aborted**, when any abort signal in `iterable` aborts.
   *                          The `reason` will be set to the reason of the first abort signal that is aborted.
   */
  static any(iterable) {
    const controller = new AbortController();
    for (const signal of iterable)
      if (signal.aborted) {
        controller.abort(signal.reason);
        break;
      } else {
        signal[anySignalsSymbol].add(controller.signal);
      }

    return controller.signal;
  }
}

export class AbortController {
  constructor() {
    // Compared to assignment, Object.defineProperty makes properties non-enumerable by default and
    // we want Object.keys(new AbortController()) to be [] for compat with the native impl
    Object.defineProperty(this, 'signal', { value: new AbortSignal(), writable: true, configurable: true });

    Object.defineProperty(this.signal, controllerSymbol, { value: this, writable: false, configurable: false, enumerable: false });
  }
  abort(reason) {
    const signalReason = normalizeAbortReason(reason);
    const event = createAbortEvent(signalReason);

    this.signal.reason = signalReason;
    this.signal.dispatchEvent(event);
  }
  toString() {
    return '[object AbortController]';
  }
}

export default AbortController;

if (typeof Symbol !== 'undefined' && Symbol.toStringTag) {
  // These are necessary to make sure that we get correct output for:
  // Object.prototype.toString.call(new AbortController())
  AbortController.prototype[Symbol.toStringTag] = 'AbortController';
  Object.defineProperty(AbortSignal.prototype, Symbol.toStringTag, {
    value: 'AbortSignal',
  });
}
