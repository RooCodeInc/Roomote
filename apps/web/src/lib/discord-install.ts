// Bitfield requested by the Add to Discord install link:
// View Channels, Send Messages, Read Message History, Embed Links, Attach
// Files, Add Reactions, Manage Threads, Create Public Threads, and Send
// Messages in Threads. Manage Threads is needed so Roomote can apply a
// moderated tag when a required-tag forum has no unmoderated tags.
export const DISCORD_INSTALL_PERMISSIONS = String(
  (1n << 6n) | // add_reactions
    (1n << 10n) | // view_channel
    (1n << 11n) | // send_messages
    (1n << 14n) | // embed_links
    (1n << 15n) | // attach_files
    (1n << 16n) | // read_message_history
    (1n << 34n) | // manage_threads
    (1n << 35n) | // create_public_threads
    (1n << 38n), // send_messages_in_threads
);
