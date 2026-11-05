# VIRUS-MD V4 — WhatsApp bot + pairing/control panel

Node.js 20+ application using Baileys. Use only an account you own or are authorized to administer. Baileys is an unofficial WhatsApp Web client; WhatsApp may change its protocol or restrict automated clients.

## What this ZIP actually includes

- WhatsApp pairing-code flow from the authenticated web control panel (`/`).
- 200 selectable monitoring slots (`Server #1` through `Server #200`). Selecting a slot in the panel shows its reported online/offline state, active-user count, and last heartbeat.
- `.servers` and `.server <1-200>` WhatsApp commands.
- Existing group moderation, warnings, welcome, anti-link, deletion notification, status-read, presence, group broadcast, channel broadcast, and owner commands listed below.
- Environment-variable protection for the control panel and restricted `.join` / `.follow` commands.

**Honest scope:** this is not a 500+ implemented-command release. It contains the working command set listed below; it does not pad the menu with fake commands. The 200 entries are monitoring slots, not 200 pre-provisioned machines or WhatsApp accounts. Each real host/instance must be deployed and configured separately to report its actual metric.

## Install and run

1. Extract the ZIP on a persistent Node.js host (Node 20 or newer).
2. Run `npm install`.
3. Configure these secrets/environment variables in the host dashboard:
   - `CONTROL_PANEL_PASSWORD`: strong unique secret; required for the web panel and heartbeat API.
   - `OWNER_NUMBER`: your own WhatsApp number, country code + digits, no plus sign.
   - `FOLLOW_ALLOWED_NUMBER`: optional single number permitted to run `.join` / `.follow`.
   - `PORT`: optional, commonly supplied by the host.
   - `PAIRING_NUMBER`: optional; if set, startup pairing code is printed to server logs. Otherwise use the web panel.
4. Run `npm start`.
5. Open `https://YOUR-HOST/` and sign in using any username and the `CONTROL_PANEL_PASSWORD` as the Basic Auth password.
6. Enter your own WhatsApp number and generate a code. On your phone: WhatsApp → Linked devices → Link a device → Link with phone number instead.
7. Keep the `auth_info/` directory persistent and private. Never share pairing codes or session files.

Static-only hosting (including a static EdgeOne site) cannot run this persistent Node.js process. Use a Node.js host with persistent storage and outbound network access.

## Server-slot reporting

The dashboard starts with slots 1–200 offline. A real instance can report its own active-user metric to:

`POST /api/heartbeat`

Authenticated with HTTP Basic Auth using `CONTROL_PANEL_PASSWORD`, JSON body:

`{"serverId":23,"activeUsers":14}`

Only report a count that the instance actually measures. The panel records the timestamp and displays the selected slot when clicked. The bot's `.server 23` command displays the same reported data. A slot is not automatically a separate server; deploy each real instance yourself. Do not run multiple Baileys processes against the same auth folder.

## Implemented commands

**General:** `.menu`, `.help`, `.ping`, `.owner`, `.jid`, `.runtime`

**Group information:** `.groupinfo`, `.admins`, `.gclink`

**Group moderation (admin permission required; bot must be admin for member actions):** `.tagall`, `.kick`, `.promote`, `.demote`, `.mute`, `.unmute`, `.warn`, `.warnings`, `.resetwarns`, `.groupname`, `.delete`

**Group settings:** `.welcome on/off`, `.antilink on/off`, `.antidelete on/off`

**Owner settings:** `.autostatus on/off`, `.alwaysonline on/off`, `.setprefix`, `.setbio`, `.getbio`, `.setgc`, `.gcstatus`, `.setchannel`, `.channelstatus`

**Restricted actions:** `.join <group-invite-link> <password>`, `.follow <channel-invite-link> <password>`

**Server monitoring:** `.servers`, `.server <1-200>`

## Important limitations

- `.antidelete` sends a deletion notification only; it does not recover deleted messages.
- `.autostatus` marks status updates as read; it does not download or redistribute them.
- `.alwaysonline` is best-effort presence, not control over a user's last-seen privacy or timestamp.
- `.gcstatus` and `.channelstatus` send replied-to content to a configured destination, subject to platform permissions.
- MP3 conversion, arbitrary last-seen setting, and a 500+ command library are not included in this build.
- The panel does not automate or coordinate votes using selected accounts/servers. It can display server activity; users should cast their own votes through the official poll interface.

## Reversals

`.mute` ↔ `.unmute`; `.promote` ↔ `.demote`; `.welcome on/off`; `.antilink on/off`; `.antidelete on/off`; `.autostatus on/off`; `.alwaysonline on/off`; `.warn` ↔ `.resetwarns`.

Kicking a member cannot be automatically undone; a group admin must invite them again.
