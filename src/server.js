import "dotenv/config";
import express from "express";
import twilio from "twilio";
import { saveToSupabase } from "./storage.js";
import { sendNotifications } from "./notify.js";
import { createServer } from "http";

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || "").replace(/\/+$/, "");

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

function cleanSpeech(value) {
  return String(value || "").trim();
}

function lower(value) {
  return cleanSpeech(value).toLowerCase();
}

function detectService(speech) {
  const text = lower(speech);

  if (text.includes("mow") || text.includes("grass") || text.includes("lawn cut")) {
    return "mowing";
  }

  if (text.includes("mulch")) {
    return "mulch";
  }

  if (text.includes("pine straw") || text.includes("pinestraw")) {
    return "pine straw";
  }

  if (text.includes("cleanup") || text.includes("clean up") || text.includes("leaves") || text.includes("leaf")) {
    return "cleanup";
  }

  if (text.includes("aerat")) {
    return "aeration";
  }

  if (text.includes("weed") || text.includes("fertiliz") || text.includes("treatment")) {
    return "weed control and fertilizer";
  }

  if (text.includes("quote") || text.includes("estimate") || text.includes("price")) {
    return "quote";
  }

  return null;
}

function getOrCreateSession(callSid, callerNumber) {
  let session = sessions.get(callSid);

  if (!session) {
    session = {
      callSid,
      callerNumber,
      startTime: new Date(),
      stage: "service",
      gathered: {
        service: null,
        address: null,
        details: null,
        name: null,
        callbackNumber: callerNumber !== "unknown" ? callerNumber : null,
      },
      transcript: [],
    };

    sessions.set(callSid, session);
  }

  return session;
}

function addTranscript(session, role, text) {
  session.transcript.push({
    role,
    text,
    time: new Date().toISOString(),
  });
}

function ask(twiml, callSid, text) {
  const gather = twiml.gather({
    input: "speech",
    action: actionUrl("/voice/respond", callSid),
    method: "POST",
    speechTimeout: "auto",
    timeout: 8,
  });

  gather.say(text);

  twiml.redirect(
    {
      method: "POST",
    },
    actionUrl("/voice/no-input", callSid)
  );
}

function summarizeGathered(gathered) {
  return [
    `Service: ${gathered.service || "Not provided"}`,
    `Address: ${gathered.address || "Not provided"}`,
    `Details: ${gathered.details || "Not provided"}`,
    `Name: ${gathered.name || "Not provided"}`,
    `Callback number: ${gathered.callbackNumber || "Not provided"}`,
  ].join("\n");
}

app.post("/voice/inbound", async (req, res) => {
  try {
    const callSid = getCallSid(req);
    const callerNumber = getCallerNumber(req);

    console.log(`Inbound call from ${callerNumber} | SID: ${callSid}`);

    const session = getOrCreateSession(callSid, callerNumber);

    const greeting =
      "Thank you for calling Buford Lawn Care and Maintenance. My name is Jordan, your virtual assistant. How may I help you today?";

    addTranscript(session, "assistant", greeting);

    const twiml = makeTwiml();
    ask(twiml, callSid, greeting);

    return sendXml(res, twiml);
  } catch (err) {
    console.error("Inbound call error:", err);

    const twiml = makeTwiml();
    twiml.say("I am sorry, something went wrong while answering the call. Please try again shortly.");
    twiml.hangup();

    return sendXml(res, twiml);
  }
});

app.post("/voice/respond", async (req, res) => {
  try {
    const callSid = getCallSid(req);
    const callerNumber = getCallerNumber(req);
    const speechResult = cleanSpeech(req.body.SpeechResult);
    const session = getOrCreateSession(callSid, callerNumber);

    console.log(`Caller said: "${speechResult}" | SID: ${callSid}`);

    const twiml = makeTwiml();

    if (!speechResult) {
      ask(twiml, callSid, "I am sorry, I did not catch that. Could you please repeat?");
      return sendXml(res, twiml);
    }

    addTranscript(session, "caller", speechResult);

    let reply = "";

    if (session.stage === "service") {
      const service = detectService(speechResult);

      if (!service) {
        reply =
          "I can help with that. What service are you needing? For example, mowing, mulch, pine straw, cleanup, aeration, or weed control.";
        addTranscript(session, "assistant", reply);
        ask(twiml, callSid, reply);
        return sendXml(res, twiml);
      }

      if (service === "quote") {
        reply =
          "I can help gather information for a quote. What service do you need? For example, mowing, mulch, pine straw, cleanup, aeration, or weed control.";
        addTranscript(session, "assistant", reply);
        ask(twiml, callSid, reply);
        return sendXml(res, twiml);
      }

      session.gathered.service = service;
      session.stage = "address";

      reply = `Great, I can help gather information for ${service}. What is the property address?`;
      addTranscript(session, "assistant", reply);
      ask(twiml, callSid, reply);
      return sendXml(res, twiml);
    }

    if (session.stage === "address") {
      session.gathered.address = speechResult;
      session.stage = "details";

      if (session.gathered.service === "mowing") {
        reply =
          "Got it. For mowing, is this a one-time cut, weekly service, or biweekly service? Also, please mention if there is a gate, locked fence, pets, or anything important about access.";
      } else if (session.gathered.service === "mulch") {
        reply =
          "Got it. For mulch, please tell me roughly how many beds need mulch, whether you already know the mulch color, and whether old mulch or weeds need to be cleaned out first.";
      } else if (session.gathered.service === "pine straw") {
        reply =
          "Got it. For pine straw, please tell me roughly how many areas need straw, and whether the beds need cleanup or edging first.";
      } else if (session.gathered.service === "cleanup") {
        reply =
          "Got it. For cleanup, please tell me what needs to be cleaned up. For example leaves, branches, overgrowth, weeds, or general yard debris.";
      } else {
        reply =
          "Got it. Please tell me any important details about the job, including size, access, timing, and anything you want us to know.";
      }

      addTranscript(session, "assistant", reply);
      ask(twiml, callSid, reply);
      return sendXml(res, twiml);
    }

    if (session.stage === "details") {
      session.gathered.details = speechResult;
      session.stage = "name";

      reply = "Thank you. What is your name?";
      addTranscript(session, "assistant", reply);
      ask(twiml, callSid, reply);
      return sendXml(res, twiml);
    }

    if (session.stage === "name") {
      session.gathered.name = speechResult;
      session.stage = "callback";

      if (session.gathered.callbackNumber && session.gathered.callbackNumber !== "unknown") {
        reply = `Thanks, ${speechResult}. Is ${session.gathered.callbackNumber} the best number to call or text you back?`;
      } else {
        reply = `Thanks, ${speechResult}. What is the best phone number to call or text you back?`;
      }

      addTranscript(session, "assistant", reply);
      ask(twiml, callSid, reply);
      return sendXml(res, twiml);
    }

    if (session.stage === "callback") {
      const text = lower(speechResult);

      if (
        !session.gathered.callbackNumber ||
        session.gathered.callbackNumber === "unknown" ||
        !["yes", "yeah", "yep", "correct", "that is right", "that's right"].some((word) => text.includes(word))
      ) {
        session.gathered.callbackNumber = speechResult;
      }

      session.stage = "done";

      const summary = summarizeGathered(session.gathered);

      reply =
        "Perfect. I have the information we need. Someone from Buford Lawn Care and Maintenance will follow up with you soon. Thank you for calling. Goodbye.";

      addTranscript(session, "assistant", reply);

      twiml.say(reply);
      twiml.hangup();

      handleCallComplete(callSid, session).catch((err) => {
        console.error("Post-call processing failed:", err);
      });

      console.log(`Call summary for ${callSid}:\n${summary}`);

      return sendXml(res, twiml);
    }

    reply =
      "Thank you. I have your information noted. Someone from Buford Lawn Care and Maintenance will follow up with you soon. Goodbye.";

    addTranscript(session, "assistant", reply);

    twiml.say(reply);
    twiml.hangup();

    handleCallComplete(callSid, session).catch((err) => {
      console.error("Post-call processing failed:", err);
    });

    return sendXml(res, twiml);
  } catch (err) {
    console.error("Conversation route error:", err);

    const callSid = getCallSid(req);
    const twiml = makeTwiml();

    ask(
      twiml,
      callSid,
      "I am sorry, I had a little trouble there. Could you say that again?"
    );

    return sendXml(res, twiml);
  }
});

app.post("/voice/no-input", async (req, res) => {
  try {
    const callSid = getCallSid(req);
    const twiml = makeTwiml();

    ask(
      twiml,
      callSid,
      "I am sorry, I did not catch that. Could you please repeat?"
    );

    return sendXml(res, twiml);
  } catch (err) {
    console.error("No input route error:", err);

    const twiml = makeTwiml();
    twiml.say("I am sorry, something went wrong. Goodbye.");
    twiml.hangup();

    return sendXml(res, twiml);
  }
});

async function handleCallComplete(callSid, session) {
  console.log(`Processing completed call ${callSid}`);

  try {
    const endTime = new Date();
    const durationSeconds = Math.round((endTime - session.startTime) / 1000);

    const transcriptText = session.transcript
      .map((entry) => `[${entry.role.toUpperCase()}]: ${entry.text}`)
      .join("\n");

    try {
      await saveToSupabase({
        call_sid: callSid,
        caller_number: session.callerNumber,
        start_time: session.startTime.toISOString(),
        end_time: endTime.toISOString(),
        duration_seconds: durationSeconds,
        transcript: transcriptText,
        gathered_info: session.gathered,
        recording_drive_url: null,
        transcript_drive_url: null,
        recording_twilio_url: null,
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
        driveLinks: {},
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

app.get("/health", (req, res) => {
  return res.json({
    status: "ok",
    uptime: process.uptime(),
  });
});

createServer(app).listen(PORT, () => {
  console.log(`Buford Lawn AI server running on port ${PORT}`);
  console.log(`Base URL: ${BASE_URL}`);
});
