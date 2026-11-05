'use strict';
/**
 * VIRUS-MD — WhatsApp group utility/moderation bot.
 * Use only with an account you own or are authorized to administer.
 * No View Once bypass, private-chat scraping, stealth tracking, or poll manipulation.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const express = require('express');
const pino = require('pino');
const {
  default: makeWASocket, useMultiFileAuthState, DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const ROOT = __dirname;
const SETTINGS_FILE = path.join(ROOT, 'settings.json');
const WARNINGS_FILE = path.join(ROOT, 'warnings.json');
const SERVERS_FILE = path.join(ROOT, 'server-slots.json');
let activeSocket = null;
let activeRegistered = false;
let pairingBusy = false;
const app = express();
app.use(express.json({ limit: '32kb' }));
const serverSlots = loadJson(SERVERS_FILE, Object.fromEntries(Array.from({length: 200}, (_, i) => [String(i + 1), {status: 'offline', activeUsers: 0, updatedAt: null}])));
function saveServers() { saveJson(SERVERS_FILE, serverSlots); }
function panelAuth(req, res, next) {
  const secret = process.env.CONTROL_PANEL_PASSWORD || '';
  if (!secret) return res.status(503).send('Set CONTROL_PANEL_PASSWORD in your hosting environment first.');
  const header = req.headers.authorization || '';
  const supplied = header.startsWith('Basic ') ? Buffer.from(header.slice(6), 'base64').toString().split(':').slice(1).join(':') : '';
  if (supplied !== secret) { res.set('WWW-Authenticate', 'Basic realm=\"VIRUS-MD Control Panel\"'); return res.status(401).send('Authentication required'); }
  next();
}
app.get('/', panelAuth, (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));
app.get('/api/servers', panelAuth, (req, res) => res.json({servers: Object.entries(serverSlots).map(([id, x]) => ({id: Number(id), ...x})), connectedBot: !!activeSocket && activeRegistered}));
app.post('/api/pair', panelAuth, async (req, res) => {
  const phone = cleanNumber(req.body?.phone);
  if (phone.length < 8 || phone.length > 15) return res.status(400).json({error: 'Enter your own WhatsApp number with country code, digits only.'});
  if (!activeSocket) return res.status(503).json({error: 'WhatsApp socket is still starting. Try again shortly.'});
  if (activeRegistered) return res.status(409).json({error: 'This bot session is already paired.'});
  if (pairingBusy) return res.status(429).json({error: 'A pairing request is already in progress.'});
  try { pairingBusy = true; const code = await activeSocket.requestPairingCode(phone); res.json({code}); }
  catch (e) { res.status(500).json({error: e.message || 'Pairing request failed.'}); }
  finally { pairingBusy = false; }
});
// Hosting instances can report their own real active-user metric to a selected slot.
app.post('/api/heartbeat', panelAuth, (req, res) => {
  const id = String(Number(req.body?.serverId)); const count = Number(req.body?.activeUsers);
  if (!serverSlots[id] || !Number.isInteger(count) || count < 0) return res.status(400).json({error: 'Invalid serverId or activeUsers.'});
  serverSlots[id] = {status: 'online', activeUsers: count, updatedAt: new Date().toISOString()}; saveServers(); res.json({ok: true});
});
app.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log(`VIRUS-MD control panel listening on port ${process.env.PORT || 3000}`));
const defaults = {
  botName: 'VIRUS-MD', prefix: '.', ownerNumber: '', pairingCodeLogin: true,
  welcome: {}, antiLink: {}, antiDelete: {}, autoStatus: {}, alwaysOnline: {}, broadcastGroup: {},
};
function loadJson(file, fallback) {
  try { return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch { return structuredClone(fallback); }
}
function saveJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }
let settings = loadJson(SETTINGS_FILE, defaults);
if (process.env.OWNER_NUMBER) settings.ownerNumber = cleanNumber(process.env.OWNER_NUMBER);
let warnings = loadJson(WARNINGS_FILE, {});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const numberOf = jid => String(jid || '').split('@')[0].split(':')[0];
const cleanNumber = s => String(s || '').replace(/\D/g, '');
const isGroup = jid => String(jid || '').endsWith('@g.us');
const textOf = m => {
  const x = m?.ephemeralMessage?.message || m?.documentWithCaptionMessage?.message || m || {};
  return x.conversation || x.extendedTextMessage?.text || x.imageMessage?.caption ||
    x.videoMessage?.caption || x.documentMessage?.caption || x.buttonsResponseMessage?.selectedButtonId ||
    x.listResponseMessage?.singleSelectReply?.selectedRowId || '';
};
const isOwner = jid => !!settings.ownerNumber && numberOf(jid) === cleanNumber(settings.ownerNumber);
const groupConfig = (obj, jid) => !!obj[jid];
const mentionText = (jids, label='Members') => `${label}: ${jids.map(j => '@' + numberOf(j)).join(' ')}`;

async function askPhone() {
  // On hosted services, configure PAIRING_NUMBER as an environment variable.
  if (process.env.PAIRING_NUMBER) return cleanNumber(process.env.PAIRING_NUMBER);
  if (!process.stdin.isTTY) throw new Error('No terminal input. Set PAIRING_NUMBER in your host environment to your own WhatsApp number, including country code (digits only), then restart.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return cleanNumber(await new Promise(resolve => rl.question('WhatsApp number with country code (e.g. 2348012345678): ', resolve))); }
  finally { rl.close(); }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(ROOT, 'auth_info'));
  let version;
  try { version = (await fetchLatestBaileysVersion()).version; }
  catch { console.warn('Could not fetch the latest WhatsApp Web version; using Baileys default.'); }

  const sock = makeWASocket({
    version, auth: state, logger: pino({ level: process.env.LOG_LEVEL || 'silent' }),
    printQRInTerminal: false, browser: [settings.botName, 'Chrome', '1.0.0'],
    markOnlineOnConnect: !!settings.alwaysOnline.global, syncFullHistory: false,
  });
  sock.ev.on('creds.update', saveCreds);

  // Pair from the authenticated web panel, or request once at startup via PAIRING_NUMBER.
  activeSocket = sock;
  activeRegistered = !!state.creds.registered;
  if (!state.creds.registered && settings.pairingCodeLogin && process.env.PAIRING_NUMBER) {
    try { const phone = cleanNumber(process.env.PAIRING_NUMBER); if (phone.length < 8 || phone.length > 15) throw new Error('Invalid PAIRING_NUMBER.'); await sleep(2500); const code = await sock.requestPairingCode(phone); console.log(`${settings.botName} pairing code: ${code}`); }
    catch (err) { console.error('PAIRING FAILED:', err.message); }
  }

  async function reply(chat, msg, body, extra={}) {
    return sock.sendMessage(chat, { text: body, ...extra }, { quoted: msg });
  }
  async function groupContext(chat, sender, msg) {
    if (!isGroup(chat)) { await reply(chat, msg, 'This command only works in a group.'); return null; }
    const meta = await sock.groupMetadata(chat);
    const actor = meta.participants.find(p => p.id === sender);
    const bot = meta.participants.find(p => p.id === sock.user.id);
    const actorAdmin = actor?.admin === 'admin' || actor?.admin === 'superadmin' || isOwner(sender);
    const botAdmin = bot?.admin === 'admin' || bot?.admin === 'superadmin';
    if (!actorAdmin) { await reply(chat, msg, 'Only group admins can use this command.'); return null; }
    return { meta, botAdmin };
  }
  async function targetFromMessage(msg, args) {
    const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.participant;
    const raw = args.find(a => /^\d{8,15}$/.test(a));
    return mentioned[0] || quoted || (raw ? `${raw}@s.whatsapp.net` : null);
  }

  // Presence is best-effort. WhatsApp controls last-seen privacy; this cannot set an arbitrary last-seen time.
  let presenceTimer = null;
  const refreshPresence = () => {
    if (presenceTimer) clearInterval(presenceTimer);
    if (settings.alwaysOnline.global) {
      sock.sendPresenceUpdate('available').catch(() => {});
      presenceTimer = setInterval(() => sock.sendPresenceUpdate('available').catch(() => {}), 60000);
    }
  };
  refreshPresence();

  // Anti-delete is notification-only: it does not recover or repost deleted content.
  sock.ev.on('messages.delete', async (event) => {
    try {
      const keys = event?.keys || (event?.keys === undefined && event?.jid && event?.id ? [{ remoteJid: event.jid, id: event.id }] : []);
      for (const key of keys) {
        const chat = key.remoteJid;
        if (chat && settings.antiDelete?.[chat]) {
          await sock.sendMessage(chat, { text: 'A message was deleted.' });
        }
      }
    } catch (e) { console.warn('Anti-delete notice:', e.message); }
  });

  // Auto-status only marks status updates as read; it does not download or redistribute them.
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages || []) {
      if (m.key?.remoteJid === 'status@broadcast' && settings.autoStatus.global) {
        try { await sock.readMessages([m.key]); } catch {}
      }
    }
  });

  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    try {
      if (action === 'add' && groupConfig(settings.welcome, id)) {
        for (const user of participants) await sock.sendMessage(id, { text: `Welcome @${numberOf(user)} to the group!`, mentions: [user] });
      }
    } catch (e) { console.warn('Welcome event:', e.message); }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages || []) {
      if (!msg.message || msg.key?.fromMe) continue;
      const chat = msg.key.remoteJid;
      const sender = msg.key.participant || chat;
      const body = textOf(msg.message).trim();

      // Optional anti-link moderation: only group admins can toggle it.
      if (isGroup(chat) && groupConfig(settings.antiLink, chat) && /(https?:\/\/|www\.|chat\.whatsapp\.com\/)/i.test(body)) {
        try {
          const meta = await sock.groupMetadata(chat);
          const senderInfo = meta.participants.find(p => p.id === sender);
          const admin = senderInfo?.admin === 'admin' || senderInfo?.admin === 'superadmin';
          if (!admin) {
            const botInfo = meta.participants.find(p => p.id === sock.user.id);
            if (botInfo?.admin) await sock.sendMessage(chat, { delete: msg.key });
            await reply(chat, msg, 'Group link filter is ON. Links from non-admin members are not allowed.');
          }
        } catch (e) { console.warn('Anti-link:', e.message); }
      }

      if (!body.startsWith(settings.prefix)) continue;
      const parts = body.slice(settings.prefix.length).trim().split(/\s+/);
      const cmd = (parts.shift() || '').toLowerCase();
      const args = parts;
      try {
        switch (cmd) {
          case 'menu': case 'help':
            await reply(chat, msg, `╭─『 ${settings.botName} 』\n│ GENERAL\n│ .menu / .help\n│ .ping\n│ .owner\n│ .groupinfo\n│ .admins\n│ .tagall [message] (admin)\n│\n│ GROUP ADMIN (admin; bot must be admin for member actions)\n│ .kick @user | .promote @user | .demote @user\n│ .mute | .unmute (group messaging)\n│ .warn @user | .warnings @user | .resetwarns @user\n│ .welcome on/off | .antilink on/off | .antidelete on/off\n│ .autostatus on/off | .alwaysonline on/off\n│ .gclink | .setgc | .gcstatus (reply to content)\n│ .groupname <new name> | .setprefix <symbol>\n│ .jid | .runtime | .getbio | .setbio <text>\n│ .join <group link> <password> | .follow <channel link> <password>\n│ .servers | .server <1-200> (monitor bot-host slots)\n│ .setchannel <channel-jid> | .channelstatus (reply to content)\n│\n│ REVERSALS\n│ .promote ↔ .demote\n│ .mute ↔ .unmute\n│ .welcome on ↔ off\n│ .antilink on ↔ off\n│ .kick cannot be automatically undone; invite the member again.\n╰────────────────`);
            break;
          case 'ping': await reply(chat, msg, 'Pong! 🟢'); break;
          case 'owner': await reply(chat, msg, settings.ownerNumber ? `Bot owner: +${cleanNumber(settings.ownerNumber)}` : 'Set ownerNumber in settings.json.'); break;
          case 'groupinfo': {
            if (!isGroup(chat)) { await reply(chat, msg, 'Use this in a group.'); break; }
            const m = await sock.groupMetadata(chat);
            await reply(chat, msg, `Name: ${m.subject}\nMembers: ${m.participants.length}\nCreated: ${m.creation ? new Date(m.creation * 1000).toLocaleDateString() : 'Not available'}`); break;
          }
          case 'admins': {
            if (!isGroup(chat)) { await reply(chat, msg, 'Use this in a group.'); break; }
            const m = await sock.groupMetadata(chat); const admins = m.participants.filter(p => p.admin);
            await reply(chat, msg, mentionText(admins.map(p => p.id), 'Group admins'), { mentions: admins.map(p => p.id) }); break;
          }
          case 'tagall': {
            const ctx = await groupContext(chat, sender, msg); if (!ctx) break;
            const ids = ctx.meta.participants.map(p => p.id);
            await reply(chat, msg, `${args.join(' ') || 'Attention everyone'}\n${mentionText(ids)}`, { mentions: ids }); break;
          }
          case 'mute': case 'unmute': {
            const ctx = await groupContext(chat, sender, msg); if (!ctx) break;
            if (!ctx.botAdmin) { await reply(chat, msg, 'Make the bot a group admin first.'); break; }
            await sock.groupSettingUpdate(chat, cmd === 'mute' ? 'announcement' : 'not_announcement');
            await reply(chat, msg, cmd === 'mute' ? 'Group is now admin-only. Use .unmute to allow everyone to send messages.' : 'Group members can send messages again.'); break;
          }
          case 'promote': case 'demote': case 'kick': {
            const ctx = await groupContext(chat, sender, msg); if (!ctx) break;
            if (!ctx.botAdmin) { await reply(chat, msg, 'Make the bot a group admin first.'); break; }
            const target = await targetFromMessage(msg, args);
            if (!target || !isGroup(target) && !target.endsWith('@s.whatsapp.net')) { await reply(chat, msg, `Tag or reply to a member. Example: .${cmd} @user`); break; }
            if (target === sender || target === sock.user.id) { await reply(chat, msg, 'That target cannot be used.'); break; }
            await sock.groupParticipantsUpdate(chat, [target], cmd === 'kick' ? 'remove' : cmd);
            await reply(chat, msg, cmd === 'kick' ? `Removed @${numberOf(target)}. Invite them again to reverse this.` : `${cmd === 'promote' ? 'Promoted' : 'Demoted'} @${numberOf(target)}.`, { mentions: [target] }); break;
          }
          case 'warn': case 'warnings': case 'resetwarns': {
            const ctx = await groupContext(chat, sender, msg); if (!ctx) break;
            const target = await targetFromMessage(msg, args);
            if (!target) { await reply(chat, msg, `Tag or reply to a member: .${cmd} @user`); break; }
            warnings[chat] ||= {}; warnings[chat][target] ||= 0;
            if (cmd === 'warn') { warnings[chat][target]++; saveJson(WARNINGS_FILE, warnings); await reply(chat, msg, `Warning recorded for @${numberOf(target)}. Total: ${warnings[chat][target]}`, { mentions: [target] }); }
            else if (cmd === 'resetwarns') { warnings[chat][target] = 0; saveJson(WARNINGS_FILE, warnings); await reply(chat, msg, `Warnings reset for @${numberOf(target)}.`, { mentions: [target] }); }
            else await reply(chat, msg, `Warnings for @${numberOf(target)}: ${warnings[chat][target]}`, { mentions: [target] });
            break;
          }
          case 'groupname': {
            const ctx = await groupContext(chat, sender, msg); if (!ctx) break;
            if (!ctx.botAdmin) { await reply(chat, msg, 'Make the bot a group admin first.'); break; }
            const name = args.join(' ').trim(); if (!name) { await reply(chat, msg, 'Usage: .groupname New group name'); break; }
            await sock.groupUpdateSubject(chat, name); await reply(chat, msg, 'Group name updated.'); break;
          }
          case 'delete': {
            const ctx = await groupContext(chat, sender, msg); if (!ctx) break;
            const quoted = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
            const participant = msg.message?.extendedTextMessage?.contextInfo?.participant;
            if (!quoted) { await reply(chat, msg, 'Reply to a message sent by the bot, then use .delete.'); break; }
            await sock.sendMessage(chat, { delete: { remoteJid: chat, fromMe: participant === sock.user.id, id: quoted, participant } }); break;
          }
          case 'antidelete': case 'welcome': case 'antilink': case 'autostatus': case 'alwaysonline': {
            const globalFeature = ['autostatus', 'alwaysonline'].includes(cmd);
            if (globalFeature && !isOwner(sender)) { await reply(chat, msg, 'Only the bot owner can change this setting.'); break; }
            if (!globalFeature) { const ctx = await groupContext(chat, sender, msg); if (!ctx) break; }
            const table = cmd === 'welcome' ? settings.welcome : cmd === 'antilink' ? settings.antiLink : settings[cmd === 'antidelete' ? 'antiDelete' : cmd === 'autostatus' ? 'autoStatus' : 'alwaysOnline'];
            const key = globalFeature ? 'global' : chat;
            const v = (args[0] || 'status').toLowerCase();
            if (v === 'on' || v === 'off') { if (v === 'on') table[key] = true; else delete table[key]; saveJson(SETTINGS_FILE, settings); if (cmd === 'alwaysonline') refreshPresence(); await reply(chat, msg, `${cmd} is now ${v.toUpperCase()}.`); }
            else await reply(chat, msg, `${cmd}: ${table[key] ? 'ON' : 'OFF'} (use .${cmd} on/off)`);
            break;
          }
          case 'gclink': {
            if (!isGroup(chat)) { await reply(chat, msg, 'Use this command inside your group.'); break; }
            const ctx = await groupContext(chat, sender, msg); if (!ctx) break;
            if (!ctx.botAdmin) { await reply(chat, msg, 'The bot must be a group admin.'); break; }
            const code = await sock.groupInviteCode(chat); await reply(chat, msg, `Group invite link: https://chat.whatsapp.com/${code}`); break;
          }
          case 'setgc': {
            if (!isOwner(sender)) { await reply(chat, msg, 'Only the bot owner can set the broadcast group.'); break; }
            if (!isGroup(chat)) { await reply(chat, msg, 'Run this command inside the group to select it.'); break; }
            settings.broadcastGroup.global = chat; saveJson(SETTINGS_FILE, settings); await reply(chat, msg, 'This group is now the selected broadcast destination.'); break;
          }
          case 'gcstatus': {
            if (!isOwner(sender)) { await reply(chat, msg, 'Only the bot owner can broadcast.'); break; }
            const destination = settings.broadcastGroup.global;
            if (!destination) { await reply(chat, msg, 'First run .setgc inside the destination group.'); break; }
            const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
            const quotedMessage = ctxInfo?.quotedMessage;
            if (!quotedMessage) { await reply(chat, msg, 'Reply to a text, image, video, or document, then send .gcstatus.'); break; }
            await sock.sendMessage(destination, quotedMessage); await reply(chat, msg, 'Broadcast sent to the selected group.'); break;
          }
          case 'join': case 'follow': {
            const allowed = cleanNumber(process.env.FOLLOW_ALLOWED_NUMBER || '');
            const suppliedPassword = args[args.length - 1] || '';
            const expectedPassword = process.env.CONTROL_PANEL_PASSWORD || '';
            if (!allowed || numberOf(sender) !== allowed || !expectedPassword || suppliedPassword !== expectedPassword) {
              await reply(chat, msg, 'Not authorized. Configure FOLLOW_ALLOWED_NUMBER and CONTROL_PANEL_PASSWORD in the hosting environment.'); break;
            }
            const targetLink = args.slice(0, -1).join(' ');
            if (!targetLink) { await reply(chat, msg, `Usage: .${cmd} <invite-link> <control-panel-password>`); break; }
            if (cmd === 'join') {
              const match = targetLink.match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/);
              if (!match) { await reply(chat, msg, 'Provide a valid WhatsApp group invite link.'); break; }
              const result = await sock.groupAcceptInvite(match[1]); await reply(chat, msg, `Join request completed. Group: ${result}`);
            } else {
              const match = targetLink.match(/whatsapp\.com\/channel\/([A-Za-z0-9]+)/);
              if (!match) { await reply(chat, msg, 'Provide a valid WhatsApp channel invite link.'); break; }
              const metadata = await sock.newsletterMetadata('invite', match[1]);
              if (!metadata?.id) { await reply(chat, msg, 'Could not resolve that channel invite.'); break; }
              await sock.newsletterFollow(metadata.id); settings.followedChannel = metadata.id; saveJson(SETTINGS_FILE, settings);
              await reply(chat, msg, `Follow request completed for ${metadata.name || 'the channel'}.`);
            }
            break;
          }
          case 'setchannel': {
            if (!isOwner(sender)) { await reply(chat, msg, 'Only the bot owner can set the channel destination.'); break; }
            const jid = args[0]; if (!jid || !jid.endsWith('@newsletter')) { await reply(chat, msg, 'Usage: .setchannel <channel-jid>'); break; }
            settings.broadcastChannel = jid; saveJson(SETTINGS_FILE, settings); await reply(chat, msg, 'Channel broadcast destination saved.'); break;
          }
          case 'channelstatus': {
            if (!isOwner(sender)) { await reply(chat, msg, 'Only the bot owner can broadcast.'); break; }
            const destination = settings.broadcastChannel || settings.followedChannel;
            const quotedMessage = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            if (!destination || !quotedMessage) { await reply(chat, msg, 'Set/follow a channel first, then reply to content with .channelstatus.'); break; }
            await sock.sendMessage(destination, quotedMessage); await reply(chat, msg, 'Channel send request submitted. Availability depends on your WhatsApp channel permissions and Baileys version.'); break;
          }
          case 'servers': {
            const entries = Object.entries(serverSlots);
            const online = entries.filter(([,v]) => v.status === 'online');
            const totalUsers = online.reduce((n, [,v]) => n + (Number(v.activeUsers) || 0), 0);
            await reply(chat, msg, `VIRUS-MD HOST SLOTS\nOnline: ${online.length}/200\nReported active users: ${totalUsers}\nUse .server <1-200> for a slot's details.\nPanel: open the hosted control-panel URL.`); break;
          }
          case 'server': {
            const id = String(Number(args[0]));
            if (!args[0] || !serverSlots[id] || !Number.isInteger(Number(args[0]))) { await reply(chat, msg, 'Usage: .server 1 (choose a slot from 1 to 200).'); break; }
            const v = serverSlots[id];
            await reply(chat, msg, `SERVER #${id}\nStatus: ${v.status}\nActive users reported: ${v.activeUsers || 0}\nLast update: ${v.updatedAt || 'Never'}`); break;
          }
          case 'setprefix': {
            if (!isOwner(sender)) { await reply(chat, msg, 'Only the bot owner can change the prefix.'); break; }
            const value = args[0]; if (!value || value.length > 3) { await reply(chat, msg, 'Usage: .setprefix !'); break; }
            settings.prefix = value; saveJson(SETTINGS_FILE, settings); await reply(chat, msg, `Prefix changed to ${value}`); break;
          }
          case 'jid': await reply(chat, msg, `Chat JID: ${chat}\nYour JID: ${sender}`); break;
          case 'runtime': { const sec = Math.floor(process.uptime()); await reply(chat, msg, `Uptime: ${Math.floor(sec/3600)}h ${Math.floor(sec%3600/60)}m ${sec%60}s`); break; }
          case 'getbio': { const bio = await sock.fetchStatus(sender).catch(() => null); await reply(chat, msg, bio?.status || 'No profile bio available.'); break; }
          case 'setbio': { if (!isOwner(sender)) { await reply(chat, msg, 'Only the bot owner can change the bot profile status.'); break; } const bio = args.join(' ').trim(); if (!bio) { await reply(chat, msg, 'Usage: .setbio Your status text'); break; } await sock.updateProfileStatus(bio); await reply(chat, msg, 'Profile status updated.'); break; }
          default: if (cmd) await reply(chat, msg, `Unknown command: ${settings.prefix}${cmd}\nUse .menu to see commands.`);
        }
      } catch (err) { console.error(`Command ${cmd} failed:`, err.message); await reply(chat, msg, `Command failed: ${err.message || 'unknown error'}`).catch(() => {}); }
    }
  });

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') { activeRegistered = true; console.log(`${settings.botName} connected successfully.`); }
    if (connection === 'close') { activeRegistered = false; activeSocket = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) console.error('Logged out. Delete auth_info only if you intend to pair again.');
      else { console.log('Connection closed; reconnecting...'); setTimeout(() => startBot().catch(console.error), 3000); }
    }
  });
}
startBot().catch(err => { console.error('Startup error:', err); process.exit(1); });
