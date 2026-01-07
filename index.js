import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import { DateTime } from "luxon";

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM,
  ORHAN_WHATSAPP_TO,
  PAYPAL_ME_LINK = ""
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM || !ORHAN_WHATSAPP_TO) {
  console.error("❌ Missing env vars. Required: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM, ORHAN_WHATSAPP_TO");
}

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// ---------- Config (V1) ----------
const TZ = "Europe/Berlin";
const OPEN_DAYS = [1, 2, 3, 4, 5]; // Mon-Fri (Luxon: Mon=1 ... Sun=7)
const PICKUP_START = { hour: 7, minute: 0 };  // pickup allowed from 07:00
const PICKUP_END = { hour: 15, minute: 0 };   // pickup allowed until 15:00
const LEAD_TIME_MIN = 30;

// ---------- In-memory sessions (V1) ----------
/**
 * sessions[from] = {
 *  state: "ASK_PICKUP"|"ASK_ORDER"|"ASK_PAYMENT"|"CONFIRM",
 *  pickupAtISO: string,
 *  orderText: string,
 *  payment: "PAYPAL"|"VOR_ORT"
 * }
 */
const sessions = new Map();

function normalize(text) {
  return (text || "").trim();
}

function lower(text) {
  return normalize(text).toLowerCase();
}

function nowBerlin() {
  return DateTime.now().setZone(TZ);
}

function isOpenDay(dt) {
  return OPEN_DAYS.includes(dt.weekday);
}

function nextOpenDayAt7(dt) {
  let d = dt;
  while (!isOpenDay(d)) d = d.plus({ days: 1 }).startOf("day");
  return d.set({ hour: PICKUP_START.hour, minute: PICKUP_START.minute, second: 0, millisecond: 0 });
}

function earliestPickup(dtNow) {
  // earliest = now + lead time, but not before 07:00, and only on open days
  let candidate = dtNow.plus({ minutes: LEAD_TIME_MIN });

  if (!isOpenDay(candidate)) {
    return nextOpenDayAt7(candidate);
  }

  const todayStart = candidate.set({ hour: PICKUP_START.hour, minute: PICKUP_START.minute, second: 0, millisecond: 0 });
  const todayEnd = candidate.set({ hour: PICKUP_END.hour, minute: PICKUP_END.minute, second: 0, millisecond: 0 });

  if (candidate < todayStart) candidate = todayStart;
  if (candidate > todayEnd) {
    // after pickup window -> next open day 07:00
    return nextOpenDayAt7(candidate.plus({ days: 1 }).startOf("day"));
  }
  return candidate;
}

function parsePickupTime(input, dtNow) {
  // Accept: "7", "07", "7:15", "07:15", "15:00"
  const t = lower(input).replace(/\./g, ":");
  const match = t.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!match) return { ok: false };

  const h = Number(match[1]);
  const m = match[2] ? Number(match[2]) : 0;
  if (Number.isNaN(h) || Number.isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return { ok: false };

  // We schedule for the next valid open day (today if possible, else next)
  const dtE = earliestPickup(dtNow);

  // target day = dtE's date (the earliest feasible date)
  let target = dtE.set({ hour: h, minute: m, second: 0, millisecond: 0 });

  // Ensure pickup window 07:00-15:00
  const dayStart = target.set({ hour: PICKUP_START.hour, minute: PICKUP_START.minute, second: 0, millisecond: 0 });
  const dayEnd = target.set({ hour: PICKUP_END.hour, minute: PICKUP_END.minute, second: 0, millisecond: 0 });
  if (target < dayStart || target > dayEnd) return { ok: false };

  // If target is before earliest feasible, bump to earliest feasible
  if (target < dtE) target = dtE;

  // If target falls on closed day (shouldn’t, but just in case)
  if (!isOpenDay(target)) {
    target = nextOpenDayAt7(target);
  }

  return { ok: true, dt: target };
}

function fmtPickup(dt) {
  return dt.setLocale("de").toFormat("cccc, dd.LL.yyyy 'um' HH:mm");
}

function helpPickup(dtNow) {
  const e = earliestPickup(dtNow);
  return (
    `Wann möchtest du abholen? (Mo–Fr, 07:00–15:00)\n` +
    `⏱️ Mindest-Vorlauf: ${LEAD_TIME_MIN} Min.\n` +
    `Frühestens möglich: ${fmtPickup(e)}\n\n` +
    `Antworte bitte nur mit Uhrzeit, z.B.: 07:30 oder 12:10`
  );
}

async function sendToOrhan(order) {
  const text =
    `🧾 *NEUE VORBESTELLUNG*\n` +
    `Kunde: ${order.customer}\n` +
    `Abholung: ${order.pickup}\n` +
    `Zahlung: ${order.payment}\n` +
    `Bestellung:\n${order.items}\n\n` +
    `Status: Bitte bestätigen & vorbereiten ✅`;

  await client.messages.create({
    from: TWILIO_WHATSAPP_FROM,
    to: ORHAN_WHATSAPP_TO,
    body: text
  });
}

// ---------- Routes ----------
app.get("/", (req, res) => {
  res.send("WhatsApp Bot läuft ✅");
});

app.post("/twilio/inbound", async (req, res) => {
  const from = req.body.From;     // e.g. "whatsapp:+4917..."
  const body = normalize(req.body.Body);

  console.log("📩 Incoming:", { from, body });

  const twiml = new twilio.twiml.MessagingResponse();
  const msg = (t) => twiml.message(t);

  const dtNow = nowBerlin();
  const cmd = lower(body);

  // Global commands
  if (cmd === "abbrechen" || cmd === "storno" || cmd === "stop") {
    sessions.delete(from);
    msg("Alles klar — Vorgang abgebrochen. Wenn du neu starten willst, schreib: *neu* ✅");
    res.type("text/xml").send(twiml.toString());
    return;
  }
  if (cmd === "neu" || cmd === "start") {
    sessions.delete(from);
  }

  const session = sessions.get(from) || { state: "ASK_PICKUP" };

  try {
    if (!sessions.has(from)) {
      msg(
        `Hallo 👋 Willkommen bei *Orhan’s Café* ☕🥐\n` +
        `Du kannst jederzeit vorbestellen.\n\n` +
        `Öffnungszeiten: Mo–Fr 06:30–15:00\n` +
        `Abholung möglich: 07:00–15:00\n\n` +
        `${helpPickup(dtNow)}\n\n` +
        `Du kannst jederzeit *abbrechen* schreiben.`
      );
      sessions.set(from, session);
      res.type("text/xml").send(twiml.toString());
      return;
    }

    if (session.state === "ASK_PICKUP") {
      const parsed = parsePickupTime(body, dtNow);
      if (!parsed.ok) {
        msg(`Ich hab die Uhrzeit nicht verstanden.\n\n${helpPickup(dtNow)}`);
        res.type("text/xml").send(twiml.toString());
        return;
      }
      session.pickupAtISO = parsed.dt.toISO();
      session.state = "ASK_ORDER";
      sessions.set(from, session);

      msg(
        `Top ✅ Abholung ist eingeplant für: *${fmtPickup(parsed.dt)}*\n\n` +
        `Was möchtest du bestellen?\n` +
        `Schreib es einfach als Text (z.B. „2x Cappuccino, 1x Croissant“).`
      );
      res.type("text/xml").send(twiml.toString());
      return;
    }

    if (session.state === "ASK_ORDER") {
      if (body.length < 2) {
        msg("Bitte schreib kurz, was du bestellen möchtest (z.B. „1x Latte, 2x Simit“).");
        res.type("text/xml").send(twiml.toString());
        return;
      }
      session.orderText = body;
      session.state = "ASK_PAYMENT";
      sessions.set(from, session);

      msg(
        `Danke ✅\n\n` +
        `Wie möchtest du bezahlen?\n` +
        `1) *PayPal*\n` +
        `2) *Vor Ort*\n\n` +
        `Antworte mit: PayPal oder Vor Ort`
      );
      res.type("text/xml").send(twiml.toString());
      return;
    }

    if (session.state === "ASK_PAYMENT") {
      const p = lower(body);
      let payment = null;
      if (p.includes("paypal")) payment = "PAYPAL";
      if (p.includes("vor")) payment = "VOR_ORT";

      if (!payment) {
        msg("Bitte antworte mit *PayPal* oder *Vor Ort* 🙂");
        res.type("text/xml").send(twiml.toString());
        return;
      }

      session.payment = payment;
      session.state = "CONFIRM";
      sessions.set(from, session);

      const pickup = DateTime.fromISO(session.pickupAtISO, { zone: TZ });
      msg(
        `Bitte kurz bestätigen ✅\n\n` +
        `🕒 Abholung: *${fmtPickup(pickup)}*\n` +
        `🧾 Bestellung: *${session.orderText}*\n` +
        `💳 Zahlung: *${payment === "PAYPAL" ? "PayPal" : "Vor Ort"}*\n\n` +
        `Antworte mit *JA* zum Bestätigen.\n` +
        `Oder schreibe *neu* um neu zu starten.`
      );
      res.type("text/xml").send(twiml.toString());
      return;
    }

    if (session.state === "CONFIRM") {
      if (lower(body) !== "ja") {
        msg("Kein Problem 🙂 Antworte mit *JA* zum Bestätigen oder schreibe *neu* für einen Neustart.");
        res.type("text/xml").send(twiml.toString());
        return;
      }

      const pickup = DateTime.fromISO(session.pickupAtISO, { zone: TZ });
      await sendToOrhan({
        customer: from,
        pickup: fmtPickup(pickup),
        payment: session.payment === "PAYPAL" ? "PayPal" : "Vor Ort",
        items: session.orderText
      });

      sessions.delete(from);

      let confirmText =
        `✅ Danke! Deine Vorbestellung ist eingegangen.\n` +
        `Abholung: *${fmtPickup(pickup)}*\n\n` +
        `Falls du doch abbrechen musst: schreib einfach *storno*.\n` +
        `Bis gleich ☕`;

      if (session.payment === "PAYPAL" && PAYPAL_ME_LINK) {
        confirmText += `\n\nPayPal Link: ${PAYPAL_ME_LINK}`;
      } else if (session.payment === "PAYPAL" && !PAYPAL_ME_LINK) {
        confirmText += `\n\nPayPal-Link folgt gleich (Orhan kann dir sonst vor Ort helfen).`;
      }

      msg(confirmText);
      res.type("text/xml").send(twiml.toString());
      return;
    }

    // Fallback
    sessions.delete(from);
    msg(`Ich starte kurz neu 🙂\n\n${helpPickup(dtNow)}`);
    res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("❌ Error in inbound:", err);
    msg("Ups — da ist etwas schiefgelaufen. Bitte schreib nochmal *neu* 🙂");
    res.type("text/xml").send(twiml.toString());
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Server läuft auf Port", PORT));
