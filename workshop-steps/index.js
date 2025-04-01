import Fastify from "fastify";
import fastifyWs from "@fastify/websocket";
import fastifyFormbody from "@fastify/formbody";
import dotenv from "dotenv";
dotenv.config();

const PORT = process.env.PORT || 8080;
const DOMAIN = process.env.NGROK_URL;
const WS_URL = `wss://${DOMAIN}/ws`;
const WELCOME_GREETING =
  "Hi! I am a voice assistant powered by Twilio and Open A I . Ask me anything!";
const SYSTEM_PROMPT =
  "You are a helpful assistant. This conversation is being translated to voice, so answer carefully. When you respond, please spell out all numbers, for example twenty not 20. Do not include emojis in your responses. Do not include bullet points, asterisks, or special symbols.";

const sessions = new Map();

import OpenAI from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
async function aiResponseStream(messages, ws) {
  const stream = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: messages,
    stream: true,
  });

  const assistantSegments = [];
  console.log("Received response chunks:");
  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content || "";

    // Send each token
    console.log(content);
    ws.send(
      JSON.stringify({
        type: "text",
        token: content,
        last: false,
      })
    );
    assistantSegments.push(content);
  }

  const finalResponse = assistantSegments.join("");
  console.log("Assistant response complete:", finalResponse);
  messages.push({
    role: "assistant",
    content: finalResponse,
  });
}

const fastify = Fastify({ logger: true });
fastify.register(fastifyWs);
fastify.register(fastifyFormbody);
fastify.all("/twiml", async (request, reply) => {
  reply.type("text/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <ConversationRelay url="${WS_URL}" welcomeGreeting="${WELCOME_GREETING}" />
      </Connect>
    </Response>`
  );
});

fastify.register(async function (fastify) {
  fastify.get("/ws", { websocket: true }, (ws, req) => {
    ws.on("message", async (data) => {
      const message = JSON.parse(data);

      switch (message.type) {
        case "setup":
          const callSid = message.callSid;
          console.log("Setup for call:", callSid);
          ws.callSid = callSid;
          sessions.set(callSid, [{ role: "system", content: SYSTEM_PROMPT }]);
          break;
        case "prompt":
          console.log("Processing prompt:", message.voicePrompt);

          const messages = sessions.get(ws.callSid);
          messages.push({ role: "user", content: message.voicePrompt });

          await aiResponseStream(messages, ws);

          // Send the final "last" token when streaming completes
          ws.send(
            JSON.stringify({
              type: "text",
              token: "",
              last: true,
            })
          );
          break;
        default:
          console.warn("Unknown message type received:", message.type);
          break;
      }
    });

    ws.on("close", () => {
      console.log("WebSocket connection closed");
      sessions.delete(ws.callSid);
    });
  });
});

try {
  fastify.listen({ port: PORT });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
