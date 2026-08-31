import postgres from 'postgres';
const sql = postgres('postgres://postgres:password@localhost:15432/roomote_development', { max: 1 });
console.log('events:', JSON.stringify(await sql`select delivery_id, state, attempts, last_error from agentmail_webhook_events order by received_at desc limit 3`));
console.log('conversations:', JSON.stringify(await sql`select id, provider_thread_id, owner_user_id, latest_inbound_message_id from agentmail_conversations order by created_at desc limit 3`));
console.log('turns:', JSON.stringify(await sql`select state, provider_message_id from agentmail_inbound_turns order by created_at desc limit 3`));
await sql.end();
