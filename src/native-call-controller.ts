import type { API } from '#zca';
import { extractCallControls, sendCallSignal } from './call-signaling.js';
import type { CallControl, CallSignalInputs, CallSignalOperation } from './call-signaling.js';
import { NativeCallBridgeError, startNativeCallBridge } from './native-call-bridge.js';
import type { NativeCallBridge, NativeCallBridgeOptions, NativeCallMessage, NativeCallRequestOptions, NativeCallStatus, NativeMakeCallRequest } from './native-call-bridge.js';
import { ZaloProtocolError } from './protocol-request.js';
import { isRealtimeFrameFeedForApi, startRealtimeFrameFeed } from './realtime-feed.js';
import type { RealtimeFrame, RealtimeFrameFeed } from './realtime-feed.js';

const errors = {
  'unsupported-signal': 'The native helper sent an unsupported call command.',
  'invalid-signal': 'The native helper sent invalid call parameters.',
  'feed-mismatch': 'Use a realtime feed opened for this authenticated Zalo API.',
  'signal-failed': 'The Zalo native call signal failed.',
  'control-failed': 'The Zalo incoming call control could not be forwarded.',
  'handler-failed': 'The Zalo native call application handler failed.',
  'realtime-failed': 'The Zalo call controller encountered a realtime error.',
  'realtime-not-ready': 'Wait for the Zalo call controller to connect before starting a call.',
} as const;

export class NativeCallControllerError extends Error {
  constructor(readonly code: keyof typeof errors, readonly command?: number) {
    super(errors[code]);
    this.name = 'NativeCallControllerError';
  }
}

type Data = Record<string, unknown>;
type Signal = { operation: CallSignalOperation; alias?: Readonly<Record<string, string>> };
type ControllerError = NativeCallControllerError | NativeCallBridgeError | ZaloProtocolError;
const presenceAliases = { audiostate: 'audioState', videostate: 'videoState' };
const stateAliases = { ...presenceAliases, callstate: 'callState' };
const signals: Readonly<Record<number, Signal | undefined>> = {
  401: { operation: 'reserve', alias: { typeRequest: 'type' } },
  416: { operation: 'request' },
  407: { operation: 'ring' },
  402: { operation: 'answer', alias: { session_id: 'session' } },
  408: { operation: 'acknowledge' },
  405: { operation: 'cancel', alias: { callerId: 'toId' } },
  409: { operation: 'end', alias: { uidTo: 'toId' } },
  411: { operation: 'holdRequest' },
  412: { operation: 'holdResponse' },
  413: { operation: 'unholdRequest' },
  414: { operation: 'unholdResponse' },
  406: { operation: 'logEnd', alias: { call_id: 'callId', partner_id: 'partnerId', logdata: 'data' } },
  12006: { operation: 'setCameraMicrophone' },
  12064: { operation: 'setScreenShare' },
  12433: { operation: 'reserveGroup' },
  12434: { operation: 'requestGroup' },
  12435: { operation: 'addGroupParticipants' },
  12436: { operation: 'answerGroup' },
  12437: { operation: 'cancelGroup' },
  12438: { operation: 'endGroup' },
  12439: { operation: 'ringGroup' },
  12445: { operation: 'getGroupState' },
  12446: { operation: 'finishGroup' },
  12447: { operation: 'notifyGroup' },
  12097: { operation: 'pingGroup', alias: stateAliases },
  12098: { operation: 'broadcastGroup', alias: stateAliases },
  12043: { operation: 'joinGroup', alias: presenceAliases },
  12044: { operation: 'setGroupScreenShare', alias: presenceAliases },
};

function object(value: unknown): value is Data {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface NativeCallControllerOptions {
  native?: Omit<NativeCallBridgeOptions, 'onMessage' | 'signal'>;
  /** The caller can share an active feed for the same authenticated API. */
  feed?: RealtimeFrameFeed;
  /** The caller's native init data, including identity, device policy and settings. */
  init: Data;
  /** Approve each realtime control forwarded to the helper. Approving a request can ring locally. */
  shouldForwardControl(control: CallControl): boolean | Promise<boolean>;
  /** Native requests and updates that need application policy are delivered here. */
  onNativeMessage?(message: NativeCallMessage): void | Promise<void>;
  onError?(error: ControllerError): void | Promise<void>;
  signal?: AbortSignal;
}

export interface NativeCallController {
  /** True after WebSocket key negotiation. */
  readonly ready: Promise<boolean>;
  /** Send an explicit application message, such as makeCall, to the native helper. */
  send(message: NativeCallMessage): Promise<void>;
  /** Ask the native helper to start an explicit call and return its local disposition. */
  makeCall(data: NativeMakeCallRequest, options?: NativeCallRequestOptions): Promise<NativeCallStatus>;
  hide(options?: NativeCallRequestOptions): Promise<NativeCallStatus>;
  /** Sends the local command and waits for the socket acknowledgment. */
  endCall(): Promise<void>;
  close(): Promise<void>;
  readonly closed: Promise<void>;
}

/** Experimental: connect the private native helper bridge to an authenticated SDK session. */
export async function startNativeCallController(api: API, options: NativeCallControllerOptions): Promise<NativeCallController> {
  const { init, shouldForwardControl, onNativeMessage, onError } = options;
  if (!object(init) || typeof shouldForwardControl !== 'function') {
    throw new TypeError('Supply native call initialization data and a control forwarding policy.');
  }
  if (options.feed && !isRealtimeFrameFeedForApi(options.feed, api)) {
    throw new NativeCallControllerError('feed-mismatch');
  }
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let bridge: NativeCallBridge | undefined;
  let feed = options.feed;
  let unsubscribe: (() => void) | undefined;
  const ownsFeed = !feed;
  let armed = false;
  let inCall = false;
  let pendingSignals = Promise.resolve();
  let pendingControls = Promise.resolve();

  function report(error: ControllerError) {
    if (!onError || signal.aborted) return;
    try { void Promise.resolve(onError(error)).catch(() => {}); }
    catch { /* An application error handler cannot interrupt the controller. */ }
  }

  async function sendSignal(message: NativeCallMessage) {
    if (!bridge || !armed || signal.aborted) return;
    const command = typeof message.command === 'number' ? message.command : undefined;
    const spec = command === undefined ? undefined : signals[command];
    if (!spec) return report(new NativeCallControllerError('unsupported-signal', command));
    const payload = message.data;
    if (!object(payload)) return report(new NativeCallControllerError('invalid-signal', command));
    const input = { ...payload };
    for (const [field, nativeField] of Object.entries(spec.alias ?? {})) input[field] = payload[nativeField];
    try {
      const data = await sendCallSignal(api, spec.operation, input as CallSignalInputs[CallSignalOperation], { signal });
      await bridge.send({ type: 'recvSignal', command, data });
    } catch (error) {
      report(error instanceof ZaloProtocolError || error instanceof NativeCallBridgeError
        ? error : new NativeCallControllerError('signal-failed', command));
    }
  }

  function onNative(message: NativeCallMessage) {
    if (message.type === 'sendSignal') {
      pendingSignals = pendingSignals.then(() => sendSignal(message));
      return;
    }
    if (message.type === 'update' && message.command === 'callState' && object(message.data)) {
      inCall = typeof message.data.state === 'string' && message.data.state !== 'free';
    }
    if (onNativeMessage) {
      const fail = () => report(new NativeCallControllerError('handler-failed'));
      try { void Promise.resolve(onNativeMessage(message)).catch(fail); }
      catch { fail(); }
    }
  }

  async function forward(control: CallControl) {
    if (!bridge || signal.aborted) return;
    try {
      if (!await shouldForwardControl(control) || signal.aborted) return;
      const incoming = control.act === 'request' || control.act === 'group_request';
      await bridge.send({
        type: 'control',
        data: { ...control, act_type: 'voip', ...(incoming ? { inCallStatus: inCall ? 'zalo' : null } : {}) },
      });
    } catch { report(new NativeCallControllerError('control-failed')); }
  }

  function onFrame(frame: RealtimeFrame) {
    if ((frame.cmd !== 601 && frame.cmd !== 603) || frame.errorCode || !object(frame.payload)) return;
    const code = frame.payload.error_code;
    if (code !== undefined && code !== 0 && code !== '0') return;
    for (const control of extractCallControls(frame.payload.data)) {
      pendingControls = pendingControls.then(() => forward(control));
    }
  }

  function stopFeed() {
    unsubscribe?.();
    unsubscribe = undefined;
    if (ownsFeed) feed?.stop();
  }

  try {
    bridge = await startNativeCallBridge({ ...options.native, signal, onMessage: onNative });
    await bridge.send({ type: 'update', command: 'init', data: init });
    if (feed) unsubscribe = feed.subscribe(onFrame, [601, 603]);
    else feed = startRealtimeFrameFeed(api, {
      commands: [601, 603], signal, onFrame,
      onError() { report(new NativeCallControllerError('realtime-failed')); },
    });
    armed = true;
  } catch (error) {
    stopFeed();
    controller.abort();
    await bridge?.close();
    throw error;
  }

  function stop() {
    armed = false;
    stopFeed();
    // Abort requests before a closed helper can emit further work.
    controller.abort();
  }
  const closed = Promise.race([bridge.closed, feed.closed]).then(async (error) => {
    if (error) report(error);
    stop();
    await Promise.all([bridge.closed, ownsFeed ? feed.closed : undefined]);
  });
  let realtimeReady = false;
  void feed.ready.then((value) => { realtimeReady = value; });
  return {
    ready: feed.ready,
    send(message) { return bridge.send(message); },
    async makeCall(data, requestOptions) {
      if (!armed || !realtimeReady) throw new NativeCallControllerError('realtime-not-ready');
      return bridge.request('makeCall', data, requestOptions);
    },
    hide(requestOptions) { return bridge.request('hide', null, requestOptions); },
    endCall() { return bridge.send({ type: 'request', command: 'endCall', data: null }); },
    async close() {
      armed = false;
      stopFeed();
      const closing = bridge.close();
      controller.abort();
      await closing;
      await closed;
    },
    closed,
  };
}
