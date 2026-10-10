'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const W='86551e44-7504-4d30-b453-c9e04b269a43', A='11111111-1111-4111-8111-111111111111', U='22222222-2222-4222-8222-222222222222', X='33333333-3333-4333-8333-333333333333', TAG='a'.repeat(64);
test('shared prices enforce member reads, admin writes, version conflicts and revoked roles in PostgreSQL', async t=>{
 const db=new PGlite(), q=async(s,p=[]) => (await db.query(s,p)).rows;
 const schema=fs.readFileSync(path.join(__dirname,'../supabase/precios.sql'),'utf8');
 const bootstrap=fs.readFileSync(path.join(__dirname,'supabase-sql.test.cjs'),'utf8').match(/const bootstrap = `([\s\S]*?)`;/)[1];
 const price99=Buffer.from('fictional encrypted payload for 9.99').toString('base64'),price79=Buffer.from('fictional encrypted payload for 7.99').toString('base64');
 const set=(price,version)=>q('select public.mega_product_price_set($1,$2,$3,$4) as price',[W,TAG,price,version]);
 async function as(role,user,work){await db.exec('reset role');await q("select set_config('request.jwt.claim.sub',$1,false)",[user||'']);await db.exec(`set role ${role}`);try{return await work();}finally{await db.exec('reset role');}}
 const denied=(work,code='42501')=>assert.rejects(work,e=>e.code===code);
 try{
  await db.exec(bootstrap);await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/auditoria.sql'),'utf8'));await db.exec(schema);
  for(const [id,name] of [[A,'admin'],[U,'colega'],[X,'externo']])await q('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[id,name+'@usuarios.megaregalonexcel.invalid']);
  await q("insert into public.mega_audit_members(workspace_id,user_id,role) values($1,$2,'admin'),($1,$3,'user')",[W,A,U]);
  await t.test('only an admin RPC saves a shared price and official identity/time',async()=>{
   const [saved]=await as('authenticated',A,()=>set(price99,0));assert.equal(saved.price.version,1);assert.equal(saved.price.updated_by,A);assert.ok(Date.parse(saved.price.updated_at));
   const [updated]=await as('authenticated',A,()=>set(price79,1));assert.equal(updated.price.version,2);
   const rows=await as('authenticated',U,()=>q('select * from public.mega_product_prices'));assert.equal(rows[0].encrypted_price,price79);
  });
  await t.test('workers and outsiders cannot write even with direct SQL',async()=>{
   await as('authenticated',U,async()=>{await denied(()=>set(price99,2));for(const sql of ['update public.mega_product_prices set version=9','delete from public.mega_product_prices','truncate public.mega_product_prices'])await denied(()=>q(sql));});
   assert.deepEqual(await as('authenticated',X,()=>q('select * from public.mega_product_prices')),[]);await as('authenticated',X,()=>denied(()=>set(price99,2)));await as('anon',null,()=>denied(()=>set(price99,2)));
  });
  await t.test('stale writes cannot overwrite another update; malformed values are rejected',async()=>{
   await as('authenticated',A,()=>denied(()=>set(price99,1),'40001'));
   await as('authenticated',A,()=>denied(()=>q('select public.mega_product_price_set($1,$2,$3,2)',[W,'bad-tag',price99]),'22023'));
   assert.equal((await q('select version,encrypted_price from public.mega_product_prices'))[0].encrypted_price,price79);
  });
  await t.test('restrictive policies resist broad accidental grants and permissive policies',async()=>{
   await db.exec('grant select,insert,update,delete on public.mega_product_prices to authenticated,anon; create policy overly_broad on public.mega_product_prices for all to authenticated,anon using(true) with check(true)');
   assert.deepEqual(await as('authenticated',U,()=>q('update public.mega_product_prices set version=8 returning *')),[]);
   assert.equal((await q('select version from public.mega_product_prices'))[0].version,2);
   assert.deepEqual(await as('authenticated',X,()=>q('select * from public.mega_product_prices')),[]);assert.deepEqual(await as('anon',null,()=>q('select * from public.mega_product_prices')),[]);
  });
  await t.test('migration is repeatable and role revocation immediately blocks saves',async()=>{
   await db.exec(schema);assert.equal((await q('select version from public.mega_product_prices'))[0].version,2);
   await q("update public.mega_audit_members set role='user' where user_id=$1",[A]);await as('authenticated',A,()=>denied(()=>set(price99,2)));
  });
 }finally{await db.close();}
});
