import "dotenv/config";
import express from "express";
// SignalWire is API-compatible with Twilio — we use the Twilio SDK pointed at SignalWire
import twilio from "twilio";
import { speak, AUDIO_DIR } from "./speak.js";
import { getAgentResponse, initConversation } from "./agent.js";
import { saveToSupabase, uploadToDrive } from "./storage.js";
import { sendNotifications } from "./notify.js";
import { createServer } from "http";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL; // e.g. https://yourapp.railway.app

// Serve generated TTS audio files so Twilio can fetch them
app.use("/audio", express.static(AUDIO_DIR));

// In-memory call sessions (fine for this scale, Supabase handles persistence)
const sessions = new Map();

// ─── TWILIO INBOUND CALL WEBHOOK ─────────────────────────────────────────────
// Twilio hits this when a forwarded call comes in
app.post("/voice/inbound", async (req, res) => {
  const callSid = req.body.CallSid;
  const callerNumber = req.body.From;

  console.log(`📞 Inbound call from ${callerNumber} | SID: ${callSid}`);

  // Initialize a fresh conversation session
  sessions.set(callSid, {
    callSid,
    callerNumber,
    startTime: new Date(),
    conversation: initConversation(),
    transcript: [],
    gathered: {},
  });

  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  // Start recording the full call
  twiml.record({
    recordingStatusCallback: `${BASE_URL}/voice/recording-complete`,
    recordingStatusCallbackMethod: "POST",
  });

  // Use <Connect> with a stream for real-time audio, OR use <Gather> for simpler flow
  // We use the <Gather> loop approach — reliable, no WebSocket infra needed
  twiml.redirect(`${BASE_URL}/voice/greet?callSid=${callSid}`);

  res.type("text/xml");
  res.send(twiml.toString());
});

// ─── GREET CALLER ─────────────────────────────────────────────────────────────
app.post("/voice/greet", async (req, res) => {
  const callSid = req.query.callSid || req.body.CallSid;
  const session = sessions.get(callSid);

  const greeting =
    "Thank you for calling Buford Lawn Care and Maintenance. My name is Jordan, a virtual assistant. How may I help you today?";

  if (session) {
    session.transcript.push({ role: "assistant", text: greeting });
  }

  const audioUrl = await speak(greeting, callSid, "greeting");

  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  twiml.gather({
    input: "speech",
    speechTimeout: "auto",
    speechModel: "phone_call",
    enhanced: "true",
    action: `${BASE_URL}/voice/respond?callSid=${callSid}`,
    method: "POST",
    timeout: 10,
  }).play(audioUrl);

  // If no input, prompt again
  twiml.redirect(`${BASE_URL}/voice/no-input?callSid=${callSid}`);

  res.type("text/xml");
  res.send(twiml.toString());
});

// ─── MAIN CONVERSATION LOOP ───────────────────────────────────────────────────
app.post("/voice/respond", async (req, res) => {
  const callSid = req.query.callSid || req.body.CallSid;
  const speechResult = req.body.SpeechResult || "";
  const session = sessions.get(callSid);

  console.log(`🗣  Caller said: "${speechResult}"`);

  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  if (!session) {
    twiml.say("I'm sorry, something went wrong. Please call back.");
    twiml.hangup();
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  // Save what the caller said
  session.transcript.push({ role: "caller", text: speechResult });

  // Get AI response
  const { reply, isDone, gathered } = await getAgentResponse(
    session.conversation,
    speechResult,
    session.gathered
  );

  // Update session
  session.transcript.push({ role: "assistant", text: reply });
  session.gathered = { ...session.gathered, ...gathered };

  const audioUrl = await speak(reply, callSid, `turn_${session.transcript.length}`);

  if (isDone) {
    // Wrap up the call
    twiml.play(audioUrl);
    twiml.hangup();

    // Async post-call processing (don't await — let call hang up cleanly)
    handleCallComplete(callSid, session).catch(console.error);
  } else {
    twiml.gather({
      input: "speech",
      speechTimeout: "auto",
      speechModel: "phone_call",
      enhanced: "true",
      action: `${BASE_URL}/voice/respond?callSid=${callSid}`,
      method: "POST",
      timeout: 10,
    }).play(audioUrl);

    twiml.redirect(`${BASE_URL}/voice/no-input?callSid=${callSid}`);
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

// ─── NO INPUT HANDLER ─────────────────────────────────────────────────────────
app.post("/voice/no-input", async (req, res) => {
  const callSid = req.query.callSid || req.body.CallSid;
  const session = sessions.get(callSid);

  const prompt = "I'm sorry, I didn't catch that. Could you please repeat?";
  const audioUrl = await speak(prompt, callSid, "no_input");

  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  twiml.gather({
    input: "speech",
    speechTimeout: "auto",
    action: `${BASE_URL}/voice/respond?callSid=${callSid}`,
    method: "POST",
    timeout: 10,
  }).play(audioUrl);

  twiml.hangup();

  res.type("text/xml");
  res.send(twiml.toString());
});

// ─── RECORDING COMPLETE CALLBACK ─────────────────────────────────────────────
app.post("/voice/recording-complete", async (req, res) => {
  const callSid = req.body.CallSid;
  const recordingUrl = req.body.RecordingUrl;
  const recordingSid = req.body.RecordingSid;

  console.log(`🎙  Recording ready for ${callSid}: ${recordingUrl}`);

  const session = sessions.get(callSid);
  if (session) {
    session.recordingUrl = recordingUrl + ".mp3";
    session.recordingSid = recordingSid;
  }

  res.sendStatus(200);
});

// ─── POST-CALL PROCESSING ─────────────────────────────────────────────────────
async function handleCallComplete(callSid, session) {
  console.log(`✅ Processing completed call ${callSid}`);

  try {
    const endTime = new Date();
    const durationSeconds = Math.round((endTime - session.startTime) / 1000);

    // Build full transcript text
    const transcriptText = session.transcript
      .map((t) => `[${t.role.toUpperCase()}]: ${t.text}`)
      .join("\n");

    // Wait briefly for recording to be available
    await new Promise((r) => setTimeout(r, 5000));

    // Upload recording + transcript to Google Drive
    let driveLinks = {};
    if (session.recordingUrl) {
      driveLinks = await uploadToDrive({
        callSid,
        callerNumber: session.callerNumber,
        recordingUrl: session.recordingUrl,
        transcriptText,
        startTime: session.startTime,
      });
    }

    // Save summary to Supabase
    const supabaseRecord = await saveToSupabase({
      call_sid: callSid,
      caller_number: session.callerNumber,
      start_time: session.startTime.toISOString(),
      end_time: endTime.toISOString(),
      duration_seconds: durationSeconds,
      transcript: transcriptText,
      gathered_info: session.gathered,
      recording_drive_url: driveLinks.recordingUrl || null,
      transcript_drive_url: driveLinks.transcriptUrl || null,
      recording_twilio_url: session.recordingUrl || null,
    });

    // Send notifications
    await sendNotifications({
      callerNumber: session.callerNumber,
      startTime: session.startTime,
      durationSeconds,
      gathered: session.gathered,
      transcriptText,
      driveLinks,
    });

    // Clean up session from memory
    sessions.delete(callSid);

    console.log(`📬 All post-call tasks complete for ${callSid}`);
  } catch (err) {
    console.error(`❌ Post-call processing error for ${callSid}:`, err);
  }
}

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime() }));

// ─── START SERVER ─────────────────────────────────────────────────────────────
createServer(app).listen(PORT, () => {
  console.log(`🚀 Buford Lawn AI server running on port ${PORT}`);
  console.log(`📡 Base URL: ${BASE_URL}`);
});
