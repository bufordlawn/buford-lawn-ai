import "dotenv/config";
import express from "express";
import twilio from "twilio";
import { speak, AUDIO_DIR } from "./speak.js";
import { getAgentResponse, initConversation } from "./agent.js";
import { saveToSupabase, uploadToDrive } from "./storage.js";
import { sendNotifications } from "./notify.js";
import { createServer } from "http";

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || "").replace(/\/+$/, "");

app.use("/audio", express.static(AUDIO_DIR));

const sessions = new Map();

function makeTwiml() {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  return new VoiceResponse();
}

function sendXml(res, twiml) {
  res.type("text/xml");
  return res.send(twiml.toString());
}

function getCallSid(req) {
  return req.query.callSid || req.body.CallSid || req.body.callSid || `call_${Date.now()}`;
}

function getCallerNumber(req) {
  return req.body.From || req.body.Caller || req.body.from || "unknown";
}

function actionUrl(path, callSid) {
  return `${BASE_URL}${path}?callSid=${encodeURIComponent(callSid)}`;
}

function getOrCreateSession(callSid, callerNumber) {
  let session = sessions.get(callSid);

  if (!session) {
    session = {
      callSid,
      callerNumber,
      startTime: new Date(),
      conversation: initConversation(),
      gathered: {},
      transcript: [],
      recordingUrl: null,
      recordingSid: null,
    };

    sessions.set(callSid, session);
  }

  return session;
}

// -----------------------------------------------------------------------------
// Inbound call handler
// -----------------------------------------------------------------------------
app.post("/voice/inbound", async (req, res) => {
  try {
    const callSid = getCallSid(req);
    const callerNumber = getCallerNumber(req);

    console.log(`Inbound call from ${callerNumber} | SID: ${callSid}`);

    const session = getOrCreateSession(callSid, callerNumber);

    const greeting =
      "Thank you for calling Buford Lawn Care and Maintenance. My name is Jordan, your virtual assistant. How may I help you today?";

    session.transcript.push({ role: "assistant", text: greeting });

    const twiml = makeTwiml();

    const gather = twiml.gather({
      input: "speech",
      action: actionUrl("/voice/respond", callSid),
      method: "POST",
      speechTimeout: "auto",
      timeout: 8,
    });

    gather.say(greeting);

    twiml.redirect(
      {
        method: "POST",
      },
      actionUrl("/voice/no-input", callSid)
    );

    return sendXml(res, twiml);
  } catch (err) {
    console.error("Inbound call error:", err);

    const twiml = makeTwiml();
    twiml.say(
      "I am sorry, something went wrong while answering the call. Please try again shortly."
    );
    twiml.hangup();

    return sendXml(res, twiml);
  }
});

// -----------------------------------------------------------------------------
// Optional greet route
// -----------------------------------------------------------------------------
app.post("/voice/greet", async (req, res) => {
  try {
    const callSid = getCallSid(req);
    const callerNumber = getCallerNumber(req);
    const session = getOrCreateSession(callSid, callerNumber);

    const greeting =
      "Thank you for calling Buford Lawn Care and Maintenance. My name is Jordan, your virtual assistant. How may I help you today?";

    session.transcript.push({ role: "assistant", text: greeting });

    const twiml = makeTwiml();

    const gather = twiml.gather({
      input: "speech",
      action: actionUrl("/voice/respond", callSid),
      method: "POST",
      speechTimeout: "auto",
      timeout: 8,
    });

    gather.say(greeting);

    twiml.redirect(
      {
        method: "POST",
      },
      actionUrl("/voice/no-input", callSid)
    );

    return sendXml(res, twiml);
  } catch (err) {
    console.error("Greet route error:", err);

    const twiml = makeTwiml();
    twiml.say("I am sorry, something went wrong. Please call back shortly.");
    twiml.hangup();

    return sendXml(res, twiml);
  }
});

// -----------------------------------------------------------------------------
// Main conversation loop
// -----------------------------------------------------------------------------
app.post("/voice/respond", async (req, res) => {
  try {
    const callSid = getCallSid(req);
    const callerNumber = getCallerNumber(req);
    const speechResult = req.body.SpeechResult || "";
    const session = getOrCreateSession(callSid, callerNumber);

    console.log(`Caller said: "${speechResult}" | SID: ${callSid}`);

    const twiml = makeTwiml();

    if (!speechResult.trim()) {
      twiml.redirect(
        {
          method: "POST",
        },
        actionUrl("/voice/no-input", callSid)
      );

      return sendXml(res, twiml);
    }

    session.transcript.push({ role: "caller", text: speechResult });

    const agentResult = await getAgentResponse(
      session.conversation,
      speechResult,
      session.gathered
    );

    const reply =
      agentResult?.reply ||
      "Thank you. I have that noted. What else can I help you with today?";

    const isDone = Boolean(agentResult?.isDone);
    const gathered = agentResult?.gathered || {};

    session.transcript.push({ role: "assistant", text: reply });
    session.gathered = {
      ...session.gathered,
      ...gathered,
    };

    let audioUrl = null;

    try {
      audioUrl = await speak(reply, callSid, `turn_${session.transcript.length}`);
    } catch (ttsErr) {
      console.error("TTS error, falling back to Say:", ttsErr);
    }

    if (isDone) {
      if (audioUrl) {
        twiml.play(audioUrl);
      } else {
        twiml.say(reply);
      }

      twiml.hangup();

      handleCallComplete(callSid, session).catch((err) => {
        console.error("Post-call processing failed:", err);
      });

      return sendXml(res, twiml);
    }

    const gather = twiml.gather({
      input: "speech",
      action: actionUrl("/voice/respond", callSid),
      method: "POST",
      speechTimeout: "auto",
      timeout: 8,
    });

    if (audioUrl) {
      gather.play(audioUrl);
    } else {
      gather.say(reply);
    }

    twiml.redirect(
      {
        method: "POST",
      },
      actionUrl("/voice/no-input", callSid)
    );

    return sendXml(res, twiml);
  } catch (err) {
    console.error("Conversation route error:", err);

    const callSid = getCallSid(req);
    const twiml = makeTwiml();

    twiml.say(
      "I am sorry, I had trouble processing that. Let me try again. What service are you calling about today?"
    );

    twiml.redirect(
      {
        method: "POST",
      },
      actionUrl("/voice/greet", callSid)
    );

    return sendXml(res, twiml);
  }
});

// -----------------------------------------------------------------------------
// No input handler
// -----------------------------------------------------------------------------
app.post("/voice/no-input", async (req, res) => {
  try {
    const callSid = getCallSid(req);

    const twiml = makeTwiml();

    const gather = twiml.gather({
      input: "speech",
      action: actionUrl("/voice/respond", callSid),
      method: "POST",
      speechTimeout: "auto",
      timeout: 8,
    });

    gather.say("I am sorry, I did not catch that. Could you please repeat?");

    twiml.say(
      "I still did not hear anything. Thank you for calling Buford Lawn Care and Maintenance. Goodbye."
    );
    twiml.hangup();

    return sendXml(res, twiml);
  } catch (err) {
    console.error("No input route error:", err);

    const twiml = makeTwiml();
    twiml.say("I am sorry, something went wrong. Goodbye.");
    twiml.hangup();

    return sendXml(res, twiml);
  }
});

// -----------------------------------------------------------------------------
// Recording complete callback
// -----------------------------------------------------------------------------
app.post("/voice/recording-complete", async (req, res) => {
  try {
    const callSid = req.body.CallSid;
    const recordingUrl = req.body.RecordingUrl;
    const recordingSid = req.body.RecordingSid;

    console.log(`Recording ready for ${callSid}: ${recordingUrl}`);

    const session = sessions.get(callSid);

    if (session) {
      session.recordingUrl = recordingUrl ? `${recordingUrl}.mp3` : null;
      session.recordingSid = recordingSid || null;
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("Recording callback error:", err);
    return res.sendStatus(200);
  }
});

// -----------------------------------------------------------------------------
// Post-call processing
// -----------------------------------------------------------------------------
async function handleCallComplete(callSid, session) {
  console.log(`Processing completed call ${callSid}`);

  try {
    const endTime = new Date();
    const durationSeconds = Math.round((endTime - session.startTime) / 1000);

    const transcriptText = session.transcript
      .map((entry) => `[${entry.role.toUpperCase()}]: ${entry.text}`)
      .join("\n");

    let driveLinks = {};

    if (session.recordingUrl) {
      try {
        driveLinks = await uploadToDrive({
          callSid,
          callerNumber: session.callerNumber,
          recordingUrl: session.recordingUrl,
          transcriptText,
          startTime: session.startTime,
        });
      } catch (driveErr) {
        console.error("Google Drive upload failed:", driveErr);
      }
    }

    try {
      await saveToSupabase({
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
    } catch (supabaseErr) {
      console.error("Supabase save failed:", supabaseErr);
    }

    try {
      await sendNotifications({
        callerNumber: session.callerNumber,
        startTime: session.startTime,
        durationSeconds,
        gathered: session.gathered,
        transcriptText,
        driveLinks,
      });
    } catch (notifyErr) {
      console.error("Notification failed:", notifyErr);
    }

    sessions.delete(callSid);

    console.log(`Post-call tasks complete for ${callSid}`);
  } catch (err) {
    console.error(`Post-call processing error for ${callSid}:`, err);
  }
}

// -----------------------------------------------------------------------------
// Health check
// -----------------------------------------------------------------------------
app.get("/health", (req, res) => {
  return res.json({
    status: "ok",
    uptime: process.uptime(),
  });
});

// -----------------------------------------------------------------------------
// Start server
// -----------------------------------------------------------------------------
createServer(app).listen(PORT, () => {
  console.log(`Buford Lawn AI server running on port ${PORT}`);
  console.log(`Base URL: ${BASE_URL}`);
});
