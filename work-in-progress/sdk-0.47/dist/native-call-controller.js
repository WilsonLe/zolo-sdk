import { extractCallControls, sendCallSignal } from './call-signaling.js';
import { NativeCallBridgeError, startNativeCallBridge } from './native-call-bridge.js';
import { ZaloProtocolError } from './protocol-request.js';
import { isRealtimeFrameFeedForApi, startRealtimeFrameFeed } from './realtime-feed.js';
const errors = {
    'unsupported-signal': 'The native helper sent an unsupported call command.',
    'invalid-signal': 'The native helper sent invalid call parameters.',
    'feed-mismatch': 'Use a realtime feed opened for this authenticated Zalo API.',
    'signal-failed': 'The Zalo native call signal failed.',
    'control-failed': 'The Zalo incoming call control could not be forwarded.',
    'handler-failed': 'The Zalo native call application handler failed.',
    'realtime-failed': 'The Zalo call controller encountered a realtime error.',
    'realtime-not-ready': 'Wait for the Zalo call controller to connect before starting a call.',
};
export class NativeCallControllerError extends Error {
    code;
    command;
    constructor(code, command) {
        super(errors[code]);
        this.code = code;
        this.command = command;
        this.name = 'NativeCallControllerError';
    }
}
const presenceAliases = { audiostate: 'audioState', videostate: 'videoState' };
const stateAliases = { ...presenceAliases, callstate: 'callState' };
const signals = {
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
function object(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Experimental: connect the private native helper bridge to an authenticated SDK session. */
export async function startNativeCallController(api, options) {
    const { init, shouldForwardControl, onNativeMessage, onError } = options;
    if (!object(init) || typeof shouldForwardControl !== 'function') {
        throw new TypeError('Supply native call initialization data and a control forwarding policy.');
    }
    if (options.feed && !isRealtimeFrameFeedForApi(options.feed, api)) {
        throw new NativeCallControllerError('feed-mismatch');
    }
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    let bridge;
    let feed = options.feed;
    let unsubscribe;
    const ownsFeed = !feed;
    let armed = false;
    let inCall = false;
    let pendingSignals = Promise.resolve();
    let pendingControls = Promise.resolve();
    function report(error) {
        if (!onError || signal.aborted)
            return;
        try {
            void Promise.resolve(onError(error)).catch(() => { });
        }
        catch { /* An application error handler cannot interrupt the controller. */ }
    }
    async function sendSignal(message) {
        if (!bridge || !armed || signal.aborted)
            return;
        const command = typeof message.command === 'number' ? message.command : undefined;
        const spec = command === undefined ? undefined : signals[command];
        if (!spec)
            return report(new NativeCallControllerError('unsupported-signal', command));
        const payload = message.data;
        if (!object(payload))
            return report(new NativeCallControllerError('invalid-signal', command));
        const input = { ...payload };
        for (const [field, nativeField] of Object.entries(spec.alias ?? {}))
            input[field] = payload[nativeField];
        try {
            const data = await sendCallSignal(api, spec.operation, input, { signal });
            await bridge.send({ type: 'recvSignal', command, data });
        }
        catch (error) {
            report(error instanceof ZaloProtocolError || error instanceof NativeCallBridgeError
                ? error : new NativeCallControllerError('signal-failed', command));
        }
    }
    function onNative(message) {
        if (message.type === 'sendSignal') {
            pendingSignals = pendingSignals.then(() => sendSignal(message));
            return;
        }
        if (message.type === 'update' && message.command === 'callState' && object(message.data)) {
            inCall = typeof message.data.state === 'string' && message.data.state !== 'free';
        }
        if (onNativeMessage) {
            const fail = () => report(new NativeCallControllerError('handler-failed'));
            try {
                void Promise.resolve(onNativeMessage(message)).catch(fail);
            }
            catch {
                fail();
            }
        }
    }
    async function forward(control) {
        if (!bridge || signal.aborted)
            return;
        try {
            if (!await shouldForwardControl(control) || signal.aborted)
                return;
            const incoming = control.act === 'request' || control.act === 'group_request';
            await bridge.send({
                type: 'control',
                data: { ...control, act_type: 'voip', ...(incoming ? { inCallStatus: inCall ? 'zalo' : null } : {}) },
            });
        }
        catch {
            report(new NativeCallControllerError('control-failed'));
        }
    }
    function onFrame(frame) {
        if ((frame.cmd !== 601 && frame.cmd !== 603) || frame.errorCode || !object(frame.payload))
            return;
        const code = frame.payload.error_code;
        if (code !== undefined && code !== 0 && code !== '0')
            return;
        for (const control of extractCallControls(frame.payload.data)) {
            pendingControls = pendingControls.then(() => forward(control));
        }
    }
    function stopFeed() {
        unsubscribe?.();
        unsubscribe = undefined;
        if (ownsFeed)
            feed?.stop();
    }
    try {
        bridge = await startNativeCallBridge({ ...options.native, signal, onMessage: onNative });
        await bridge.send({ type: 'update', command: 'init', data: init });
        if (feed)
            unsubscribe = feed.subscribe(onFrame, [601, 603]);
        else
            feed = startRealtimeFrameFeed(api, {
                commands: [601, 603], signal, onFrame,
                onError() { report(new NativeCallControllerError('realtime-failed')); },
            });
        armed = true;
    }
    catch (error) {
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
        if (error)
            report(error);
        stop();
        await Promise.all([bridge.closed, ownsFeed ? feed.closed : undefined]);
    });
    let realtimeReady = false;
    void feed.ready.then((value) => { realtimeReady = value; });
    return {
        ready: feed.ready,
        send(message) { return bridge.send(message); },
        async makeCall(data, requestOptions) {
            if (!armed || !realtimeReady)
                throw new NativeCallControllerError('realtime-not-ready');
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
