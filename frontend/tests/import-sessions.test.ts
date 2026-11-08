import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, getSession, saveImage, removeSession } from '../lib/server/import-sessions.ts';

// Opt-in integration test against the published module, using disposable rows.
// Run: node --env-file=.env --test frontend/tests/import-sessions.test.ts
// with TEST_IMPORT_DB=1. No database owner credentials are sent.
test('shared pairing enforces capabilities, transfers photos, and deletes data', { skip: process.env.TEST_IMPORT_DB !== '1' }, async () => {
  const session = await createSession();
  try {
    assert.equal(session.id.length, 32);
    assert.notEqual(session.reader, session.uploader);
    assert.ok(session.expires > Date.now());
    await assert.rejects(() => getSession(session.id, session.uploader, 'reader'), /token/);
    await assert.rejects(() => getSession(session.id, session.reader, 'uploader'), /token/);
    await assert.rejects(() => getSession('../outside', session.reader, 'reader'));
    await assert.rejects(() => saveImage(session.id, session.reader, 'data:image/jpeg;base64,dGVzdA=='), /token/);
    await assert.rejects(() => saveImage(session.id, session.uploader, 'not-an-image'), /Invalid/);
    await saveImage(session.id, session.uploader, 'data:image/jpeg;base64,dGVzdA==');
    assert.equal((await getSession(session.id, session.reader, 'reader')).image, 'data:image/jpeg;base64,dGVzdA==');
    assert.equal((await getSession(session.id, session.uploader, 'uploader')).image, undefined);
    await assert.rejects(() => removeSession(session.id, session.uploader), /token/);
  } finally { await removeSession(session.id, session.reader); }
  await assert.rejects(() => getSession(session.id, session.reader, 'reader'), /not found/);
  await assert.rejects(() => saveImage(session.id, session.uploader, 'data:image/jpeg;base64,dGVzdA=='), /not found/);
});
