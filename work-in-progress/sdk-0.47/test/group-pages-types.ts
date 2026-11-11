import {
  getGroupListPage, getGroupMemberPage, getEncryptedGroupIds,
  type API, type GroupReadPageOptions, type GroupListPage,
  type GroupMemberPage, type EncryptedGroupId, type EncryptedGroupIds,
} from 'zalo-personal-sdk';
import * as Main from 'zalo-personal-sdk';
import * as E2EE from 'zalo-personal-sdk/e2ee';

// Compile-only consumer: this function is never invoked.
async function consume(api: API, signal: AbortSignal): Promise<void> {
  const options: GroupReadPageOptions = { page: 1, count: 100, signal };
  const optional: GroupReadPageOptions = { page: undefined, count: undefined, signal: undefined };
  const listed: Promise<GroupListPage> = getGroupListPage(api, options);
  const memberRead: Promise<GroupMemberPage> = getGroupMemberPage(api, 'g123', optional);
  const encryptedRead: Promise<EncryptedGroupIds> = getEncryptedGroupIds(api, signal);
  await getGroupListPage(api);
  await getGroupMemberPage(api, '123');
  await getEncryptedGroupIds(api);
  const list = await listed, member = await memberRead, ids = await encryptedRead;
  const groupRows: readonly unknown[] = list.groups;
  const listRaw: Readonly<Record<string, unknown>> = list.raw;
  const current: readonly unknown[] | undefined = member.currentMems;
  const admins: readonly unknown[] | undefined = member.admins;
  const memberIds: readonly unknown[] | undefined = member.memberIds;
  const memberRaw: Readonly<Record<string, unknown>> = member.raw;
  const rawContinuation: unknown = list.raw.hasMore;
  const ambiguousContinuation: unknown = member.raw.hasMoreMember;
  const total: unknown = list.raw.total;
  const entries: readonly EncryptedGroupId[] = ids.entries;
  const rawIds: readonly unknown[] = ids.raw;
  for (const entry of entries) {
    const raw: unknown = entry.raw;
    const id: string | undefined = entry.id;
    if (id !== undefined) { const exactText: string = id; void exactText; }
    // @ts-expect-error An optional mechanical observation is not always present.
    const assumedId: string = entry.id;
    // @ts-expect-error The entry wrapper is readonly.
    entry.id = 'rewritten';
    // @ts-expect-error Raw is unknown and cannot grant membership/recipient trust.
    const trustedMember: { userId: string } = raw;
    void [assumedId, trustedMember];
  }
  // @ts-expect-error There is no normalized continuation field.
  const hasMore: boolean = list.hasMore;
  // @ts-expect-error No normalized total count exists.
  const numericTotal: number = list.raw.total;
  // @ts-expect-error A member page does not guarantee a collection.
  const requiredMembers: readonly unknown[] = member.currentMems;
  // @ts-expect-error A raw row is not a typed complete group record.
  const group: { groupId: string; name: string } = groupRows[0];
  // @ts-expect-error Options are readonly.
  options.page = 2;
  // @ts-expect-error Result properties are readonly.
  list.groups = [];
  // @ts-expect-error Array containers are readonly.
  list.groups.push({});
  // @ts-expect-error Raw object slots are readonly.
  list.raw.hasMore = false;
  // @ts-expect-error Member projections are readonly.
  member.currentMems = [];
  // @ts-expect-error ID result array containers are readonly.
  ids.entries.push({ raw: null });
  // @ts-expect-error ID raw array containers are readonly.
  ids.raw[0] = 'rewritten';
  // @ts-expect-error Page accepts numbers, not decimal text.
  await getGroupListPage(api, { page: '1' });
  // @ts-expect-error Count accepts numbers, not BigInt.
  await getGroupMemberPage(api, '1', { count: 100n });
  // @ts-expect-error Group ID must be text, with no numeric coercion.
  await getGroupMemberPage(api, 123);
  // @ts-expect-error Null options are unsupported.
  await getGroupListPage(api, null);
  // @ts-expect-error No arbitrary query/header or route override.
  await getGroupListPage(api, { page: 1, headers: {} });
  // @ts-expect-error No cache, pagination or retry option.
  await getGroupMemberPage(api, '1', { autoPage: true });
  // @ts-expect-error The encrypted-ID read takes a signal, not page options.
  await getEncryptedGroupIds(api, { page: 1 });
  // @ts-expect-error The ID read has no registration, peer or key-publication option.
  await getEncryptedGroupIds(api, { registrationId: 1 });
  // @ts-expect-error These standalone reads are not added to upstream API instances.
  await api.getGroupListPage();
  // @ts-expect-error The E2EE entry point is unchanged.
  await E2EE.getGroupListPage(api);
  // @ts-expect-error The E2EE entry point is unchanged.
  await E2EE.getGroupMemberPage(api, '1');
  // @ts-expect-error The E2EE entry point is unchanged.
  await E2EE.getEncryptedGroupIds(api);
  // @ts-expect-error Shared transport is not a public arbitrary request API.
  await Main.protocolRequest(api, {});
  // @ts-expect-error The private safe-signal helper is not exported.
  Main.createProtocolAbortScope(signal);
  void [groupRows, listRaw, current, admins, memberIds, memberRaw, rawContinuation,
    ambiguousContinuation, total, entries, rawIds, hasMore, numericTotal, requiredMembers, group];
}
void consume;
