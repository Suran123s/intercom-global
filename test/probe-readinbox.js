// test/probe-readinbox.js - Probe readInbox Promise resolution behavior
const { writeMessage, readInbox, readInboxSync, clearInbox } = require('../src/core/mesh');
const { MessageEnvelope } = require('../src/core/message');

async function probe() {
  console.log('[PROBE] Starting probe for readInbox...');
  const agent = 'probe_test_agent';
  
  console.log('[PROBE] Writing a message...');
  const env = MessageEnvelope.create({
    sender: 'probe_sender',
    recipient: agent,
    type: 'task_dispatch',
    payload: { hello: 'world' }
  });
  await writeMessage(agent, env);
  console.log('[PROBE] Message written successfully.');

  console.log('[PROBE] Testing readInboxSync...');
  const syncMsgs = readInboxSync(agent);
  console.log(`[PROBE] readInboxSync returned ${syncMsgs.length} messages.`);

  console.log('[PROBE] Testing await readInbox(agent) with a 3-second timeout race...');
  const readPromise = readInbox(agent);
  
  let timedOut = false;
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      timedOut = true;
      reject(new Error('READ_INBOX_DEADLOCK_TIMEOUT: await readInbox() hung indefinitely due to self-referential thenable'));
    }, 3000);
  });

  try {
    const res = await Promise.race([readPromise, timeoutPromise]);
    console.log(`[PROBE] SUCCESS: await readInbox() returned ${res.length} messages.`);
  } catch (err) {
    console.error(`[PROBE] CAUGHT ERROR: ${err.message}`);
  }

  await clearInbox(agent);
  console.log('[PROBE] Probe completed.');
  process.exit(timedOut ? 1 : 0);
}

probe().catch(err => {
  console.error('[PROBE] Fatal uncaught error:', err);
  process.exit(1);
});
