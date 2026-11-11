import type { API } from '#zca';
import type { ProtocolData } from './protocol-request.js';
export type PersonalTaskStatus = -1 | 0 | 1;
export type PersonalTaskDateType = 0 | 1 | 2 | 3 | 4 | 5;
export interface PersonalTaskAssignee extends ProtocolData {
    userId: string;
    status?: PersonalTaskStatus;
}
/** The installed schedule object; repeat uses the provider's extended cron string. */
export interface PersonalTaskSchedule {
    startTime: number;
    repeat: string;
    endTime: number;
}
export interface PersonalTask extends ProtocolData {
    id: string;
    content?: string;
    description?: string;
    creator?: string;
    assignees?: PersonalTaskAssignee[];
    watchers?: string[];
    dueDate?: number;
    dateDefaultType?: PersonalTaskDateType;
    status?: PersonalTaskStatus;
    extra?: ProtocolData | null;
    schedule?: PersonalTaskSchedule | null;
}
/** An already submitted chat message associated with this task. This helper does not send it. */
export interface PersonalTaskMessageOrigin {
    threadType: 'direct' | 'group';
    threadId: string;
    messageId: string;
    clientMessageId: string;
    senderId: string;
    messageType: number;
}
export interface CreatePersonalTaskInput {
    content: string;
    /** Desktop calls this description; it is the task's short title. */
    description?: string;
    assigneeIds: readonly string[];
    watcherIds?: readonly string[];
    /** Unix milliseconds, or -1 for no due date. */
    dueDate?: number;
    dateDefaultType?: PersonalTaskDateType;
    status?: -1 | 0;
    origin?: PersonalTaskMessageOrigin;
    schedule?: PersonalTaskSchedule | null;
    /** Installed UI attribution codes; defaults to the unclassified source, -1. */
    source?: -1 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
    signal?: AbortSignal;
}
export interface PersonalTaskChanges {
    content?: string;
    description?: string;
    assigneeIds?: readonly string[];
    watcherIds?: readonly string[];
    dueDate?: number;
    dateDefaultType?: PersonalTaskDateType;
    status?: PersonalTaskStatus;
    schedule?: PersonalTaskSchedule | null;
    signal?: AbortSignal;
}
export interface PersonalTaskListOptions {
    role?: 'all' | 'creator' | 'assignees' | 'watchers';
    status?: 'unfinished' | 'done';
    /** The three filters below are alternative conversation selectors. */
    groupId?: string;
    creatorId?: string;
    assigneeId?: string;
    scrollId?: string;
    offset?: number;
    limit?: number;
    type?: 'tasks' | 'finished-tasks' | 'all';
    signal?: AbortSignal;
}
export interface PersonalTaskListResult {
    /** The field consumed by the installed list caller. */
    totalItems?: number;
    /** Other provider fields are retained without assuming an unevidenced list-item layout. */
    raw: Readonly<ProtocolData>;
}
export interface PersonalTaskDeletion extends ProtocolData {
    id: string;
    ts?: number | string;
}
export interface PersonalTaskChangePage {
    scrollId: string;
    timestamp?: number | string;
    updated: PersonalTask[];
    deleted: PersonalTaskDeletion[];
    /** The installed verifier stops on a page with no updated or deleted records. */
    complete: boolean;
}
export interface PersonalTaskChangeOptions {
    scrollId?: string;
    /** Keep the same boundary throughout one sequence of change pages. */
    lastUpdatedTime?: number | string;
    signal?: AbortSignal;
}
/** Creates a personal task, optionally referring to an already submitted chat message. */
export declare function createPersonalTask(api: API, input: CreatePersonalTaskInput): Promise<PersonalTask>;
/** Updates an existing fetched task while preserving its provider origin metadata. */
export declare function updatePersonalTask(api: API, current: PersonalTask, changes: PersonalTaskChanges): Promise<PersonalTask>;
/** Fetches one task's current provider record. */
export declare function getPersonalTask(api: API, id: string, signal?: AbortSignal): Promise<PersonalTask>;
export declare function deletePersonalTask(api: API, id: string, signal?: AbortSignal): Promise<void>;
/** Updates the authenticated assignee's status. The provider enforces task permissions. */
export declare function setPersonalTaskStatus(api: API, id: string, value: PersonalTaskStatus, signal?: AbortSignal): Promise<void>;
/** Submits only the observed list filters, retaining unevidenced response fields for inspection. */
export declare function listPersonalTasks(api: API, options?: PersonalTaskListOptions): Promise<PersonalTaskListResult>;
/** Fetches one change page. Persist it before advancing the returned scroll ID. */
export declare function getPersonalTaskChanges(api: API, options?: PersonalTaskChangeOptions): Promise<PersonalTaskChangePage>;
/** Explicitly nudges task assignees through the installed ding operation. */
export declare function remindPersonalTasks(api: API, ids: readonly string[], signal?: AbortSignal): Promise<void>;
/** Explicitly acknowledges received task nudges. */
export declare function acknowledgePersonalTaskReminders(api: API, ids: readonly string[], signal?: AbortSignal): Promise<void>;
