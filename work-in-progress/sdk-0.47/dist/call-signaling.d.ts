import type { API } from '#zca';
type Id = string | number;
type Json = string | number | boolean | null | Json[] | {
    [key: string]: Json;
};
type Call = {
    callId: number;
};
type Caller = Call & {
    callerId: Id;
};
type Callee = Call & {
    calleeId: Id;
};
type Group = Call & {
    hostCall: Id;
    callType: number;
};
type GroupSignal = Group & {
    calleeId?: Id;
    data: Json;
    partners?: Json;
};
type GroupPresence = Call & {
    hostCall: Id;
    userId?: Id;
    audiostate: number;
    videostate: number;
};
type GroupStatus = GroupPresence & {
    callstate: number;
    params: Json;
};
/** Parameters at the HTTP boundary. Media negotiation values come from a media engine. */
export interface CallSignalInputs {
    reserve: Callee & {
        typeRequest: number;
        codec?: string | null;
    };
    request: Callee & {
        rtcpAddress: string;
        rtpAddress: string;
        codec: string;
        session: string;
        extendData?: string;
    };
    ring: Caller;
    answer: Caller & {
        status: number;
        codec?: string | null;
        rtcpAddress: string;
        rtpAddress: string;
        session_id: string;
        extendData?: string;
    };
    acknowledge: Callee;
    cancel: Caller & {
        callType: number;
    };
    end: Call & {
        uidTo: Id;
    };
    holdRequest: {
        toId: Id;
    };
    holdResponse: {
        toId: Id;
    };
    unholdRequest: {
        toId: Id;
    };
    unholdResponse: {
        toId: Id;
    };
    logEnd: {
        call_id: number;
        partner_id: Id;
        status: number;
        logdata: string;
        duration: number;
        role: boolean;
    };
    setCameraMicrophone: Callee & {
        isOnCam: number;
        isOnMic: number;
        data: Json;
    };
    setScreenShare: Call & {
        uidTo: Id;
        status: number;
    };
    reserveGroup: Call & {
        groupId: Id;
        typeRequest: number;
        data: Json;
        partners: Json;
    };
    requestGroup: Call & {
        calleeId?: Id;
        callType: number;
        data: Json;
        session: string;
        partners?: Json;
        groupId: Id;
    };
    addGroupParticipants: GroupSignal & {
        session: string;
    };
    answerGroup: GroupSignal;
    cancelGroup: GroupSignal;
    endGroup: GroupSignal;
    ringGroup: GroupSignal;
    getGroupState: Group;
    finishGroup: Group & {
        data: Json;
        duration: number;
        partners: Json;
        status: number;
        joinTime: Id;
    };
    notifyGroup: Group & {
        status: number;
        data: Json;
    };
    pingGroup: GroupStatus;
    broadcastGroup: GroupStatus;
    joinGroup: GroupPresence & {
        status: number;
        srcJoinCall: number;
        data: Json;
    };
    setGroupScreenShare: GroupPresence & {
        status: number;
        data: Json;
    };
}
export type CallSignalOperation = keyof CallSignalInputs;
/** Experimental: send one call control request. Successful acknowledgments can have no response data. */
export declare function sendCallSignal<Operation extends CallSignalOperation>(api: API, operation: Operation, input: NoInfer<CallSignalInputs[Operation]>, options?: {
    signal?: AbortSignal;
}): Promise<unknown>;
export interface CallControl {
    act: string;
    data: unknown;
}
/** Extract call controls from a decoded control batch, before a listener filters by control type. */
export declare function extractCallControls(batch: unknown): CallControl[];
export {};
