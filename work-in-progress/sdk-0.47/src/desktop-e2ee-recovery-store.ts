import { mkdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readPrivateFile, writePrivateFile } from './private-file.js';
import { canonical, clone, fields, hex, integer, limits, recoveryError, recoveryHash, sameFence,
  snapshot, validateFence, validateTransaction, ownRecoveryError } from './desktop-e2ee-recovery-state.js';
import type { DesktopE2eeRecoveryStore, DesktopE2eeRecoveryStoreSnapshot, DesktopE2eeRecoveryStoreNext,
  DesktopE2eeRecoveryFence, DesktopE2eeRecoveryTransaction, DesktopE2eeRecoveryCommittedReceipt,
  DesktopE2eeRecoveryCommitResult } from './desktop-e2ee-recovery-state.js';

interface FileRecord { format: 'desktop-e2ee-recovery-store.v1'; current: DesktopE2eeRecoveryStoreSnapshot;
  fence: DesktopE2eeRecoveryFence; receipts: DesktopE2eeRecoveryCommittedReceipt[] }
const lanes = new Map<string, Promise<void>>();
function serialized<T>(path: string, task: () => Promise<T>): Promise<T> {
  const before = lanes.get(path) ?? Promise.resolve();
  const work = before.then(task); const tail = work.then(() => {}, () => {}); lanes.set(path, tail);
  void tail.then(() => { if (lanes.get(path) === tail) lanes.delete(path); }); return work;
}
function receipt(value: unknown): DesktopE2eeRecoveryCommittedReceipt {
  const r = fields(value, ['kind','transactionId','payloadSha256','expected','next']);
  if (r.kind !== 'committed') throw recoveryError('invalid-store','store'); hex(r.transactionId,32); hex(r.payloadSha256);
  return { kind: 'committed', transactionId: r.transactionId as string, payloadSha256: r.payloadSha256 as string,
    expected: validateFence(r.expected), next: validateFence(r.next) };
}
async function syncParent(path: string): Promise<void> {
  if (process.platform !== 'win32') { const directory = await open(dirname(path),'r'); try { await directory.sync(); } finally { await directory.close(); } }
}
/** Ciphertext-only CAS/receipt storage. Applications exclude other process writers. */
export class FileDesktopE2eeRecoveryStore implements DesktopE2eeRecoveryStore {
  readonly #path: string;
  readonly load: () => Promise<DesktopE2eeRecoveryStoreSnapshot>;
  readonly commit: (transaction: DesktopE2eeRecoveryTransaction) => Promise<DesktopE2eeRecoveryCommitResult>;
  readonly lookup: (transactionId: string) => Promise<DesktopE2eeRecoveryCommittedReceipt | { readonly kind:'absent'; readonly transactionId:string }>;
  constructor(path: string) {
    if (typeof path !== 'string' || !path || Buffer.byteLength(path)>4096 || /[\x00-\x1f\x7f]/.test(path)) throw recoveryError('invalid-input','store');
    this.#path=resolve(path);
    this.load=()=>serialized(this.#path,async()=>{try{return Object.freeze({...(await this.#read()).current});}catch{throw recoveryError('invalid-store','store');}});
    this.lookup=(transactionId)=>{
      const id=hex(transactionId,32);
      return serialized(this.#path,async()=>{try{const found=(await this.#read()).receipts.find(r=>r.transactionId===id);
        return found?clone(found):Object.freeze({kind:'absent' as const,transactionId:id});}catch{throw recoveryError('invalid-store','store');}});
    };
    this.commit=(value)=>{
      let tx:DesktopE2eeRecoveryTransaction;try{tx=validateTransaction(value);}catch{return Promise.reject(recoveryError('invalid-store','store'));}
      return serialized(this.#path,async()=>{try{
        const current=await this.#read(),old=current.receipts.find(r=>r.transactionId===tx.transactionId);
        if(old){if(old.payloadSha256!==tx.payloadSha256)return Object.freeze({kind:'conflict' as const,transactionId:tx.transactionId,reason:'transaction-payload' as const});return clone(old);}
        if(!sameFence(current.fence,tx.expected))return Object.freeze({kind:'conflict' as const,transactionId:tx.transactionId,reason:'state' as const});
        if(current.receipts.length>=limits.receipts)throw recoveryError('limit-exceeded','store');
        const changed=tx.next.deviceCheckpoint!==current.current.deviceCheckpoint;
        const next:DesktopE2eeRecoveryFence={deviceRevision:integer(tx.expected.deviceRevision+(changed?1:0)),
          deviceCheckpointSha256:recoveryHash(tx.next.deviceCheckpoint),recoveryRevision:tx.expected.recoveryRevision===null?0:integer(tx.expected.recoveryRevision+1),
          recoveryCheckpointSha256:recoveryHash(tx.next.recoveryCheckpoint)};
        const committed:DesktopE2eeRecoveryCommittedReceipt={kind:'committed',transactionId:tx.transactionId,payloadSha256:tx.payloadSha256,
          expected:{...tx.expected},next};
        const saved:FileRecord={format:'desktop-e2ee-recovery-store.v1',current:{...tx.next},fence:next,receipts:[...current.receipts,committed]};
        const encoded=canonical(saved,limits.file);await writePrivateFile(this.#path,encoded,'Desktop encrypted recovery store');await syncParent(this.#path);
        return clone(committed);
      }catch(e){if(ownRecoveryError(e)?.code==='limit-exceeded')throw e;throw recoveryError('invalid-store','store');}});
    };
    Object.freeze(this);
  }
  async initialize(deviceCheckpoint:string,deviceRevision:number):Promise<void>{
    let first:FileRecord;try{const seed=snapshot({deviceCheckpoint});integer(deviceRevision);
      first={format:'desktop-e2ee-recovery-store.v1',current:seed,fence:{deviceRevision,deviceCheckpointSha256:recoveryHash(seed.deviceCheckpoint),
        recoveryRevision:null,recoveryCheckpointSha256:null},receipts:[]};}catch{throw recoveryError('invalid-input','store');}
    await serialized(this.#path,async()=>{let file;try{await mkdir(dirname(this.#path),{recursive:true,mode:0o700});
      file=await open(this.#path,'wx',0o600);await file.chmod(0o600);await file.writeFile(canonical(first,limits.file),'utf8');await file.sync();
    }catch{throw recoveryError('invalid-store','store');}finally{try{await file?.close();}catch{throw recoveryError('invalid-store','store');}}try{await syncParent(this.#path);}catch{throw recoveryError('invalid-store','store');}});
  }
  async #read():Promise<FileRecord>{
    const encoded=await readPrivateFile(this.#path,'Desktop encrypted recovery store',limits.file);if(encoded===null)throw recoveryError('invalid-store','store');
    const raw:unknown=JSON.parse(encoded);if(canonical(raw,limits.file)!==encoded)throw recoveryError('invalid-store','store');
    const f=fields(raw,['format','current','fence','receipts']);if(f.format!=='desktop-e2ee-recovery-store.v1')throw recoveryError('invalid-store','store');
    const current=snapshot(f.current),fence=validateFence(f.fence);
    if(fence.deviceCheckpointSha256!==recoveryHash(current.deviceCheckpoint)
      ||(current.recoveryCheckpoint===undefined?(fence.recoveryRevision!==null||fence.recoveryCheckpointSha256!==null)
        :(fence.recoveryRevision===null||fence.recoveryCheckpointSha256!==recoveryHash(current.recoveryCheckpoint))))throw recoveryError('invalid-store','store');
    if(!Array.isArray(f.receipts)||f.receipts.length>limits.receipts)throw recoveryError('invalid-store','store');
    const receipts=f.receipts.map(receipt),ids=new Set(receipts.map(r=>r.transactionId));if(ids.size!==receipts.length)throw recoveryError('invalid-store','store');
    // A visible rename alone is not durable confirmation after a previous failed directory fsync.
    const handle=await open(this.#path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
    try{const st=await handle.stat();if(!st.isFile()||st.nlink!==1||(process.platform!=='win32'&&(st.mode&0o077)!==0)
      ||(typeof process.getuid==='function'&&st.uid!==process.getuid()))throw recoveryError('invalid-store','store');await handle.sync();}finally{await handle.close();}
    await syncParent(this.#path);
    return{format:'desktop-e2ee-recovery-store.v1',current,fence,receipts};
  }
}
