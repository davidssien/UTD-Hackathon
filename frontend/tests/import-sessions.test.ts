import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, getSession, saveImage, removeSession } from '../lib/server/import-sessions.ts';
test('pairing separates read/upload tokens and removes data on close',async()=>{
  const session=await createSession();
  try{
    assert.equal(session.id.length,32);assert.notEqual(session.reader,session.uploader);
    await assert.rejects(()=>getSession(session.id,session.uploader,'reader'));
    await assert.rejects(()=>getSession(session.id,session.reader,'uploader'));
    await assert.rejects(()=>getSession('../outside',session.reader,'reader'));
    await saveImage(session.id,session.uploader,'data:image/png;base64,test');
    assert.equal((await getSession(session.id,session.reader,'reader')).image,'data:image/png;base64,test');
  }finally{await removeSession(session.id,session.reader);}
  await assert.rejects(()=>getSession(session.id,session.reader,'reader'));
});
test('expired pairing tokens cannot read or upload images',async()=>{
  const session=await createSession(Date.now()-16*60*1000);
  await assert.rejects(()=>getSession(session.id,session.reader,'reader'),/expired/);
  await assert.rejects(()=>saveImage(session.id,session.uploader,'data:image/png;base64,test'));
});
