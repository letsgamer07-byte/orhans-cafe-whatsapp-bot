import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";

const app = express();

// Twilio sendet application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }));

// Test-Route
app.get("/", (req, res) => {
  res.send("WhatsApp Bot läuft ✅");
});

// 🔥 TWILIO WEBHOOK 🔥
app.post("/twilio/inbound", (req, res) => {
  const incomingMessage = req.body.Body;
  const from = req.body.From;

  console.log("📩 Neue WhatsApp Nachricht:", incomingMessage, "von", from);

  const twiml = new twilio.twiml.MessagingResponse();

  twiml.message(
    "Hallo 👋\n" +
    "Willkommen bei Orhan’s Café ☕🥐\n\n" +
    "Der WhatsApp-Bot ist jetzt aktiv.\n" +
    "Bestellfunktion folgt gleich!"
  );

  res.type("text/xml");
  res.send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Server läuft auf Port", PORT);
});
