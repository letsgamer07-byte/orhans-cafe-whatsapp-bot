import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";

const app = express();

// Twilio sendet Daten als application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }));

// Health-Check (optional, aber gut)
app.get("/", (req, res) => {
  res.send("WhatsApp Bot läuft ✅");
});

// 🔥 DAS IST DER WICHTIGE TEIL 🔥
app.post("/twilio/inbound", (req, res) => {
  const incomingMessage = req.body.Body;
  const from = req.body.From;

  console.log("📩 Neue WhatsApp Nachricht:", incomingMessage, "von", from);

  const twiml = new twilio.twiml.MessagingResponse();

  twiml.message(
    "Hallo 👋\n" +
    "Willkommen bei Orhan’s Café ☕🥐\n\n" +
    "Dieser Bot ist gerade im Aufbau.\n" +
    "Bestellungen folgen bald!"
  );

  res.type("text/xml");
  res.send(twiml.toString());
});

// Render nutzt process.env.PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Server läuft auf Port", PORT);
});

