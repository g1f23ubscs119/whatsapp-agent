const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "../dashboard")));

// ── State ──────────────────────────────────────────────
let agentEnabled = false;   // false = you reply manually, true = AI replies
const chatHistory = {};     // stores all messages per contact
const contacts = {};        // stores contact names

// ── Helpers ────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync("agent.log", line + "\n");
}

function saveHistory() {
  fs.writeFileSync("chat_history.json",
    JSON.stringify({ chatHistory, contacts }, null, 2));
}

function loadHistory() {
  try {
    const data = JSON.parse(fs.readFileSync("chat_history.json", "utf8"));
    Object.assign(chatHistory, data.chatHistory || {});
    Object.assign(contacts,    data.contacts    || {});
    log(`✅ Loaded ${Object.keys(chatHistory).length} conversations`);
  } catch {
    log("No saved history — starting fresh");
  }
}

function getName(phone) {
  return contacts[phone] || phone;
}

function addMessage(phone, role, content) {
  if (!chatHistory[phone]) chatHistory[phone] = [];
  chatHistory[phone].push({ role, content, timestamp: Date.now() });
  if (chatHistory[phone].length > 50) chatHistory[phone].shift();
  saveHistory();
}

// ── UltraMsg: Send Message ──────────────────────────────
async function sendMessage(to, text) {
  await axios.post(
    `https://api.ultramsg.com/${process.env.ULTRA_INSTANCE}/messages/chat`,
    {
      token: process.env.ULTRA_TOKEN,
      to: to,
      body: text,
    },
    { headers: { "Content-Type": "application/json" } }
  );
  log(`📤 Sent to ${getName(to)}: ${text.slice(0, 60)}`);
}

// ── Groq AI: Generate Reply ───────────────────────────
async function getAIReply(phone, incomingText) {
  const history = (chatHistory[phone] || []).map(h => ({
    role: h.role,
    content: h.content,
  }));

  // add latest incoming message
  history.push({ role: "user", content: incomingText });

  const response = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: "llama-3.3-70b-versatile",
      max_tokens: 300,
      messages: [
        {
          role: "system",
          content: `You are an AI assistant replying on behalf of the WhatsApp account owner.
You are currently chatting with ${getName(phone)}.
Rules:
- Keep replies short and natural like real WhatsApp messages
- Use the chat history to stay in context
- Be friendly and helpful
- Today's date: ${new Date().toLocaleDateString()}`
        },
        ...history
      ],
    },
    {
      headers: {
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  return response.data.choices[0].message.content;
}

// ── Webhook: Receive Incoming Messages from UltraMsg ────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // always respond fast

  try {
    const data = req.body;
    const msg = data?.data;
    if (!msg || !msg.body || msg.fromMe) return; // skip if sent by us

    const from = msg.from;
    const text = msg.body;
    const name = msg.pushname || from;

    // Save contact name
    contacts[from] = name;

    log(`📥 From ${name}: ${text}`);
    addMessage(from, "user", text);

    if (agentEnabled) {
      const reply = await getAIReply(from, text);
      await sendMessage(from, reply);
      addMessage(from, "assistant", reply);
      log(`🤖 AI replied to ${name}`);
    } else {
      log(`👤 Manual mode — no auto reply`);
    }

  } catch (err) {
    log(`❌ Error: ${err.message}`);
  }
});

// ── Dashboard APIs ──────────────────────────────────────
app.get("/api/status", (req, res) => res.json({
  agentEnabled,
  totalContacts: Object.keys(contacts).length,
  totalMessages: Object.values(chatHistory).reduce((s, h) => s + h.length, 0),
}));

app.post("/api/toggle", (req, res) => {
  agentEnabled = !agentEnabled;
  log(`🔄 Agent is now ${agentEnabled ? "ON (AI)" : "OFF (Manual)"}`);
  res.json({ agentEnabled });
});

app.get("/api/contacts", (req, res) => {
  const result = Object.entries(contacts).map(([phone, name]) => {
    const h = chatHistory[phone] || [];
    const last = h[h.length - 1];
    return {
      phone, name,
      messageCount: h.length,
      lastMessage: last?.content?.slice(0, 60) || "",
      lastTime: last?.timestamp || null,
    };
  }).sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0));
  res.json(result);
});

app.get("/api/chat/:phone", (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  res.json({
    contact: { phone, name: getName(phone) },
    messages: chatHistory[phone] || [],
  });
});

app.post("/api/send", async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message)
    return res.status(400).json({ error: "phone and message required" });
  await sendMessage(phone, message);
  addMessage(phone, "assistant", message);
  res.json({ success: true });
});

// ── Start ───────────────────────────────────────────────
loadHistory();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`🚀 Server running at http://localhost:${PORT}`);
  log(`📋 Dashboard: http://localhost:${PORT}`);
  log(`🔗 Set your UltraMsg webhook to: https://YOUR-NGROK-URL/webhook`);
});