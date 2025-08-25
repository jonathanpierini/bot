import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';

const bot = new Telegraf(process.env.BOT_TOKEN);

// DB super semplice (file JSON)
const adapter = new JSONFile('db.json');
const db = new Low(adapter, { users: {}, config: {} });
await db.read();
db.data ||= { users: {}, config: {} };

// Helpers
const isAdmin = (id) => String(id) === String(process.env.ADMIN_ID);
const roles = { IT: 'IT', CN: 'CN' };

function genAlias(role) {
  const n = Math.floor(Math.random() * 900) + 100; // 100-999
  return `${role}-${n}`;
}

async function getOrCreateAlias(userId, roleHint) {
  const u = db.data.users[userId] || {};
  if (u.alias && u.role) return u.alias;
  // Se non ha ruolo, usa hint (o IT di default)
  const role = [roles.IT, roles.CN].includes(roleHint) ? roleHint : roles.IT;
  let alias;
  // Evita collisioni triviali
  do { alias = genAlias(role); } 
  while (Object.values(db.data.users).some(v => v.alias === alias));
  db.data.users[userId] = { ...u, alias, role };
  await db.write();
  return alias;
}

async function setRoleIfAccessCode(userId, code) {
  if (code === process.env.ACCESS_CODE_IT) {
    const alias = await getOrCreateAlias(userId, roles.IT);
    return { ok: true, role: roles.IT, alias };
  }
  if (code === process.env.ACCESS_CODE_CN) {
    const alias = await getOrCreateAlias(userId, roles.CN);
    return { ok: true, role: roles.CN, alias };
  }
  return { ok: false };
}

function getChannelId() {
  return db.data.config.channelId || process.env.CHANNEL_ID || null;
}

async function setChannelId(id) {
  db.data.config.channelId = id;
  await db.write();
}

// Comandi admin (solo inviati da chat canale o DM admin)
bot.command('bind', async (ctx) => {
  // Esegui il comando nel CANALE (tu come admin) per memorizzare l'ID
  if (ctx.chat?.type === 'channel' && isAdmin(ctx.message?.from?.id)) {
    await setChannelId(ctx.chat.id);
    return ctx.reply('✅ Canale agganciato come stanza di relay.');
  }
  if (isAdmin(ctx.message?.from?.id)) {
    return ctx.reply('Usa /bind direttamente nel CANALE come admin.');
  }
});

bot.command('stats', async (ctx) => {
  if (!isAdmin(ctx.message?.from?.id)) return;
  const tot = Object.keys(db.data.users).length;
  const it = Object.values(db.data.users).filter(u => u.role === roles.IT).length;
  const cn = Object.values(db.data.users).filter(u => u.role === roles.CN).length;
  await ctx.reply(`👥 Utenti: ${tot} (IT: ${it}, CN: ${cn})`);
});

bot.command('ban', async (ctx) => {
  if (!isAdmin(ctx.message?.from?.id)) return;
  const parts = ctx.message.text.split(' ').filter(Boolean);
  const target = parts[1];
  if (!target) return ctx.reply('Uso: /ban <alias>');
  const entry = Object.entries(db.data.users).find(([, v]) => v.alias === target);
  if (!entry) return ctx.reply('Alias non trovato.');
  const [userId, u] = entry;
  u.banned = true;
  await db.write();
  await ctx.reply(`🚫 Bannato ${u.alias}`);
});

// Onboarding utenti in DM
bot.start(async (ctx) => {
  await ctx.reply(
    `Benvenuto! Per entrare, manda un *codice d’accesso*:\n` +
    `• Italiani: codice IT\n• Cinesi: codice CN\n\n` +
    `Poi scrivi normalmente: i tuoi messaggi saranno pubblicati in **anonimo** nel canale.`,
    { parse_mode: 'Markdown' }
  );
});

bot.hears(/^[A-Za-z0-9_-]{4,}$/i, async (ctx, next) => {
  // Se sembra un codice, proviamo a impostare il ruolo
  if (ctx.chat.type !== 'private') return next();
  const code = ctx.message.text.trim();
  const res = await setRoleIfAccessCode(ctx.from.id, code);
  if (!res.ok) return next();
  return ctx.reply(`✅ Accesso confermato. Il tuo alias: *${res.alias}*.\nScrivi il tuo messaggio da pubblicare.`, { parse_mode: 'Markdown' });
});

// Relay di QUALSIASI messaggio testuale arrivato in DM
bot.on('message', async (ctx) => {
  try {
    if (ctx.chat.type !== 'private') return; // Solo DM
    const channelId = getChannelId();
    if (!channelId) return ctx.reply('⚠️ Canale non configurato. Attendere che l’admin esegua /bind nel canale.');

    const u = db.data.users[ctx.from.id] || {};
    if (u.banned) return; // silenzioso

    // Anti-spam semplice
    if (ctx.message.text && ctx.message.text.length > 2000) {
      return ctx.reply('Messaggio troppo lungo.');
    }

    // Blocca media (facoltativo)
    if (!ctx.message.text) {
      return ctx.reply('Per ora accettiamo solo testo.');
    }

    // Se l’utente non ha ruolo/alias, dirottalo a inviare codice
    if (!u.role || !u.alias) {
      return ctx.reply('Invia prima il tuo *codice d’accesso* (IT o CN).', { parse_mode: 'Markdown' });
    }

    const alias = u.alias;
    const text = ctx.message.text.trim();

    // Pubblica nel canale con alias
    const out = `**${alias}**:\n${text}`;
    await ctx.telegram.sendMessage(channelId, out, { parse_mode: 'Markdown' });

    // Conferma all’utente
    await ctx.reply('✅ Pubblicato in anonimo.');
  } catch (e) {
    console.error(e);
    try { await ctx.reply('Errore temporaneo. Riprova.'); } catch {}
  }
});

bot.launch().then(() => console.log('Relay bot avviato.'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
