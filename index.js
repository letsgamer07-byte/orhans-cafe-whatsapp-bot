const express = require("express");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/healthz", (req, res) => res.status(200).send("ok"));

app.post("/twilio/inbound", (req, res) => res.status(200).send("OK"));
app.post("/twilio/status", (req, res) => res.status(200).send("OK"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
