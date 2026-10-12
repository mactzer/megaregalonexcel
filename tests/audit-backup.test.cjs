'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const Crypto=require('../audit-crypto.js'),Backup=require('../audit-backup.js');
const WS='86551e44-7504-4d30-b453-c9e04b269a43',OWNER='11111111-1111-4111-8111-111111111111',PASSWORD='Contraseña ficticia para respaldo 2026';
const id=n=>'33333333-3333-4333-8333-'+String(n).padStart(12,'0');
const enc=new TextEncoder();
function directory(location) {
  const notFound=e=>{if(e.code==='ENOENT')e.name='NotFoundError';throw e;};
  return {name:path.basename(location),async *entries(){for(const f of await fs.readdir(location,{withFileTypes:true}))yield [f.name,{kind:f.isDirectory()?'directory':'file'}];},async getDirectoryHandle(name,{create=false}={}){const p=path.join(location,name);if(create)await fs.mkdir(p,{recursive:true});try{await fs.stat(p);}catch(e){notFound(e);}return directory(p);},
    async getFileHandle(name,{create=false}={}){const p=path.join(location,name);if(create){await fs.writeFile(p,'',{flag:'a'});}else try{await fs.stat(p);}catch(e){notFound(e);}
      return {async getFile(){const data=await fs.readFile(p);return {size:data.length,arrayBuffer:async()=>data.buffer.slice(data.byteOffset,data.byteOffset+data.length)};},
        async createWritable(){let pending;return {async write(data){pending=Buffer.from(data);},async close(){await fs.writeFile(p,pending);},async abort(){pending=null;}};}};}};
}
async function fixture() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mega-backup-')),folder=directory(root),recovery=Crypto.createRecoveryKey(),key=await Crypto.unlock(recovery,WS),storage=new Map(),originals=new Map();
  const snapshot={version:1,workspace_id:WS,created_at:'2026-10-12T17:00:00Z',tables:Object.fromEntries(Backup.TABLES.map(t=>[t,[]])),authors:[{user_id:OWNER,username:'ficticio'}],objects:[]};
  snapshot.tables.mega_audit_workspace.push({id:WS,key_fingerprint:key.fingerprint,label:'MegaControl'});
  snapshot.tables.mega_audit_members.push({workspace_id:WS,user_id:OWNER,role:'admin'});
  const wrapped=await (await Crypto.unlockUser('ficticio',PASSWORD,WS)).wrapRecoveryKey(recovery);
  snapshot.tables.mega_audit_user_keys.push({workspace_id:WS,user_id:OWNER,wrapped_key:Buffer.from(wrapped).toString('base64')});
  async function add(n) {
    const record={id:id(n),workspace_id:WS,created_by:OWNER,created_at:snapshot.created_at};
    record.encrypted_metadata=Buffer.from(await key.encrypt(enc.encode(JSON.stringify({salida_numero:String(n),pdf_name:'Factura.pdf',excel_name:'Salida.xlsx',row_count:1,total_units:2})),record.id+'|metadata')).toString('base64');
    if(n===1)record.encrypted_review=Buffer.from(await key.encrypt(enc.encode(JSON.stringify({reason:'Prueba de revisión cifrada'})),'audit-review-v1|'+record.id)).toString('base64');
    for(const kind of ['pdf','excel']){
      const name=WS+'/'+OWNER+'/'+record.id+'/'+kind+'.bin',plain=enc.encode((kind==='pdf'?'%PDF-1.7\n':'PK\x03\x04')+'Documento original ficticio '+n),cipher=await key.encrypt(plain,record.id+'|'+kind);
      storage.set(name,cipher);originals.set(name,plain);record[kind+'_path']=name;snapshot.objects.push({name,size:String(cipher.length),updated_at:snapshot.created_at});
    }
    snapshot.tables.mega_audit_records.push(record);
  }
  await add(1);
  const tag=await key.productIndex('0001234567890');
  snapshot.tables.mega_product_prices.push({workspace_id:WS,product_tag:tag,version:2,encrypted_price:Buffer.from(await key.encrypt(enc.encode(JSON.stringify({code:'0001234567890',cents:799})),'product-price-v1|'+tag+'|2')).toString('base64')});
  snapshot.tables.mega_product_queries.push({id:id(9),workspace_id:WS,encrypted_query:Buffer.from(await key.encrypt(enc.encode(JSON.stringify({version:1,code:'0001234567890',label:'Encontrado'})),'product-query-v1|'+id(9))).toString('base64')});
  let downloads=0;
  const options={folder,password:PASSWORD,snapshot,key,recovery,recoveryPage:Backup.offlinePage(await fs.readFile(path.join(__dirname,'../audit-crypto.js'),'utf8'),await fs.readFile(path.join(__dirname,'../audit-backup.js'),'utf8')),authorize:async()=>{},download:async name=>{downloads++;return new Uint8Array(storage.get(name));}};
  return {root,folder,options,snapshot,storage,originals,add,downloads:()=>downloads,close:()=>fs.rm(root,{recursive:true,force:true})};
}
test('backup: real encryption, exact offline restoration, complete data and key, incremental files reuse',async()=>{
  const f=await fixture();try{
    const first=await Backup.save(f.options);assert.equal(first.downloaded,2);
    const header=await fs.readFile(path.join(f.root,'respaldo.megacontrol.json'),'utf8');assert.ok(!header.includes(f.options.recovery));assert.ok(!header.includes('Factura.pdf'));assert.ok(!header.includes(PASSWORD));
    const opened=await Backup.open(f.folder,PASSWORD);assert.equal(opened.decoded.prices[0].price.cents,799);assert.equal(opened.decoded.records[0].metadata.salida_numero,'1');assert.equal(opened.recovery,f.options.recovery);
    assert.deepEqual(opened.manifest.snapshot,f.snapshot);
    const unchanged=await Backup.save(f.options);assert.equal(unchanged.downloaded,0);assert.equal(unchanged.reused,2);assert.equal(f.downloads(),2);
    await f.add(2);const updated=await Backup.save(f.options);assert.equal(updated.downloaded,2);assert.equal(updated.reused,2);assert.equal(f.downloads(),4);
    const out=await f.folder.getDirectoryHandle('restored',{create:true}),result=await Backup.restore(f.folder,PASSWORD,out);
    assert.equal(result.records,2);assert.equal(result.files,4);
    for(const [name,original]of f.originals){const [, ,record,type]=name.split('/');assert.deepEqual(await fs.readFile(path.join(f.root,'restored',result.folder,'archivos',record,type==='pdf.bin'?'original.pdf':'original.xlsx')),Buffer.from(original));assert.deepEqual(await fs.readFile(path.join(f.root,'restored',result.folder,'storage/mega-audit-documents',name)),Buffer.from(f.storage.get(name)));}
    assert.equal((await fs.readFile(path.join(f.root,'restored',result.folder,'clave-privada.txt'),'utf8')).trim(),f.options.recovery);
    const previous=await Backup.open(f.folder,PASSWORD,undefined,undefined,true);assert.equal(previous.decoded.records.length,1);
  }finally{await f.close();}
});
test('backup: wrong password and different workspace do not change the prior valid copy',async()=>{
 const f=await fixture();try{await Backup.save(f.options);const before=await fs.readFile(path.join(f.root,'respaldo.megacontrol.json'));
  await assert.rejects(Backup.save({...f.options,password:'Contraseña equivocada ficticia'}),/contraseña/);
  assert.deepEqual(await fs.readFile(path.join(f.root,'respaldo.megacontrol.json')),before);assert.equal(f.downloads(),2);
  const wrong=structuredClone(f.snapshot);wrong.tables.mega_audit_members[0].workspace_id=id(4);await assert.rejects(Backup.save({...f.options,snapshot:wrong}),/otro equipo/);
 }finally{await f.close();}
});
test('backup: damaged local file is detected and repaired by downloading only that file',async()=>{
 const f=await fixture();try{await Backup.save(f.options);const opened=await Backup.open(f.folder,PASSWORD),file=opened.manifest.files[0],local=path.join(f.root,'documents',file.sha256+'.bin');await fs.writeFile(local,'damage');
  await assert.rejects(Backup.open(f.folder,PASSWORD),/incompleto|alterado/);
  const result=await Backup.save(f.options);assert.equal(result.downloaded,1);assert.equal(result.reused,1);await Backup.open(f.folder,PASSWORD);
 }finally{await f.close();}
});
test('backup: incomplete source, network loss, interrupted commit and revoked session never validate a new copy',async()=>{
 const f=await fixture();try{await Backup.save(f.options);const before=await fs.readFile(path.join(f.root,'respaldo.megacontrol.json'));await f.add(2);
  await assert.rejects(Backup.save({...f.options,download:async()=>{throw new Error('Conexión perdida');}}),/Conexión/);assert.deepEqual(await fs.readFile(path.join(f.root,'respaldo.megacontrol.json')),before);
  await assert.rejects(Backup.save({...f.options,authorize:async()=>{throw new Error('Permiso revocado');}}),/revocado/);assert.deepEqual(await fs.readFile(path.join(f.root,'respaldo.megacontrol.json')),before);
  const missing=structuredClone(f.snapshot);missing.objects.pop();await assert.rejects(Backup.save({...f.options,snapshot:missing}),/Falta/);
  const bad=structuredClone(f.snapshot);bad.tables.mega_audit_records[0].encrypted_metadata='AQAA';await assert.rejects(Backup.save({...f.options,snapshot:bad}),/incompleto/);
  let valid=true;await assert.rejects(Backup.save({...f.options,guard:()=>{if(!valid)throw new Error('Sesión terminada');},progress:()=>{valid=false;}}),/Sesión/);assert.deepEqual(await fs.readFile(path.join(f.root,'respaldo.megacontrol.json')),before);
  await Backup.open(f.folder,PASSWORD);
 }finally{await f.close();}
});
