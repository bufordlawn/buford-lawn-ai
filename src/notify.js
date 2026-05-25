import twilio from "twilio";
import { google } from "googleapis";

// SignalWire uses the Twilio SDK but pointed at their API endpoint
const twilioClient = twilio(
  process.env.SIGNALWIRE_PROJECT_ID,
  process.env.SIGNALWIRE_API_TOKEN,
  { signalwireSpaceUrl: process.env.SIGNALWIRE_SPACE_URL }
);

// ─── FORMAT GATHERED INFO FOR NOTIFICATIONS ───────────────────────────────────
function formatGathered(gathered) {
  const fields = [
    ["Name", gathered.name],
    ["Service Address", gathered.address],
    ["Services Requested", Array.isArray(gathered.services) ? gathered.services.join(", ") : gathered.services],
    ["Frequency", gathered.frequency],
    ["Callback Number", gathered.callbackNumber],
    ["Best Time to Call", gathered.bestTimeToCall],
    ["Yard Size", gathered.yardSize],
    ["Gated", gathered.gated],
    ["Gate Code", gathered.gateCode],
    ["Obstacles", gathered.obstacles],
    ["Mulch Areas", gathered.mulchAreas],
    ["Mulch Color", gathered.mulchColor],
    ["Additional Notes", gathered.additionalNotes],
  ];

  return fields
    .filter(([_, val]) => val !== null && val !== undefined && val !== "")
    .map(([label, val]) => `  • ${label}: ${val}`)
    .join("\n");
}

// ─── SEND SMS VIA TWILIO ──────────────────────────────────────────────────────
async function sendSMS({ callerNumber, startTime, durationSeconds, gathered, driveLinks }) {
  const duration = `${Math.floor(durationSeconds / 60)}m ${durationSeconds % 60}s`;
  const time = new Date(startTime).toLocaleString("en-US", { timeZone: "America/New_York" });

  const services = Array.isArray(gathered.services)
    ? gathered.services.join(", ")
    : gathered.services || "Not specified";

  let body = `📞 NEW LEAD - Buford Lawn Care\n`;
  body += `From: ${callerNumber}\n`;
  body += `Time: ${time} ET\n`;
  body += `Duration: ${duration}\n`;
  body += `Service: ${services}\n`;
  if (gathered.name) body += `Name: ${gathered.name}\n`;
  if (gathered.address) body += `Address: ${gathered.address}\n`;
  if (gathered.callbackNumber) body += `Callback: ${gathered.callbackNumber}\n`;
  if (driveLinks?.recordingUrl) body += `🎙 Recording: ${driveLinks.recordingUrl}`;

  try {
    await twilioClient.messages.create({
      body,
      from: process.env.SIGNALWIRE_PHONE_NUMBER,
      to: process.env.NOTIFY_SMS_NUMBER,
    });
    console.log("✅ SMS notification sent");
  } catch (err) {
    console.error("SMS send error:", err.message);
  }
}

// ─── SEND EMAIL VIA GMAIL API ─────────────────────────────────────────────────
async function sendEmail({ callerNumber, startTime, durationSeconds, gathered, transcriptText, driveLinks }) {
  const auth = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
  );

  auth.setCredentials({
    refresh_token: process.env.GMAIL_REFRESH_TOKEN,
  });

  const gmail = google.gmail({ version: "v1", auth });

  const duration = `${Math.floor(durationSeconds / 60)}m ${durationSeconds % 60}s`;
  const time = new Date(startTime).toLocaleString("en-US", { timeZone: "America/New_York" });
  const formattedInfo = formatGathered(gathered);

  const subject = `📞 New Call Lead - ${gathered.name || callerNumber} | ${new Date(startTime).toLocaleDateString()}`;

  const bodyLines = [
    `New inbound call received by Jordan (AI Assistant)`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `CALL DETAILS`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `Caller Number : ${callerNumber}`,
    `Date & Time   : ${time} ET`,
    `Duration      : ${duration}`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `COLLECTED INFORMATION`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    formattedInfo || "  (No info collected)",
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `GOOGLE DRIVE LINKS`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    driveLinks?.recordingUrl ? `Recording  : ${driveLinks.recordingUrl}` : `Recording  : Not available`,
    driveLinks?.transcriptUrl ? `Transcript : ${driveLinks.transcriptUrl}` : `Transcript : Not available`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `FULL TRANSCRIPT`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    transcriptText || "(No transcript available)",
    ``,
    `---`,
    `Sent automatically by Buford Lawn Care AI Assistant`,
  ];

  const emailBody = bodyLines.join("\n");

  // Encode as base64url for Gmail API
  const rawEmail = [
    `From: ${process.env.GMAIL_FROM_ADDRESS}`,
    `To: ${process.env.NOTIFY_EMAIL_ADDRESS}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    emailBody,
  ].join("\n");

  const encodedEmail = Buffer.from(rawEmail)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  try {
    await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: encodedEmail },
    });
    console.log("✅ Email notification sent");
  } catch (err) {
    console.error("Gmail send error:", err.message);
  }
}

// ─── MAIN EXPORT ──────────────────────────────────────────────────────────────
export async function sendNotifications(params) {
  await Promise.allSettled([
    sendSMS(params),
    sendEmail(params),
  ]);
}
