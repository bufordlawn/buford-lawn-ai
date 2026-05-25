import twilio from "twilio";
import nodemailer from "nodemailer";

// ─── SIGNALWIRE CLIENT (uses Twilio SDK) ──────────────────────────────────────
const signalwireClient = twilio(
  process.env.SIGNALWIRE_PROJECT_ID,
  process.env.SIGNALWIRE_API_TOKEN,
  { signalwireSpaceUrl: process.env.SIGNALWIRE_SPACE_URL }
);

// ─── GMAIL TRANSPORTER (App Password) ────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

// ─── FORMAT GATHERED INFO ─────────────────────────────────────────────────────
function formatGathered(gathered) {
  const fields = [
    ["Name",             gathered.name],
    ["Service Address",  gathered.address],
    ["Services",         Array.isArray(gathered.services) ? gathered.services.join(", ") : gathered.services],
    ["Frequency",        gathered.frequency],
    ["Callback Number",  gathered.callbackNumber],
    ["Best Time",        gathered.bestTimeToCall],
    ["Yard Size",        gathered.yardSize],
    ["Gated",            gathered.gated],
    ["Gate Code",        gathered.gateCode],
    ["Obstacles",        gathered.obstacles],
    ["Mulch Areas",      gathered.mulchAreas],
    ["Mulch Color",      gathered.mulchColor],
    ["Notes",            gathered.additionalNotes],
  ];

  return fields
    .filter(([_, val]) => val !== null && val !== undefined && val !== "")
    .map(([label, val]) => `  • ${label}: ${val}`)
    .join("\n");
}

// ─── SEND SMS ─────────────────────────────────────────────────────────────────
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
  if (gathered.name)           body += `Name: ${gathered.name}\n`;
  if (gathered.address)        body += `Address: ${gathered.address}\n`;
  if (gathered.callbackNumber) body += `Callback: ${gathered.callbackNumber}\n`;
  if (driveLinks?.recordingUrl) body += `🎙 Recording: ${driveLinks.recordingUrl}`;

  try {
    await signalwireClient.messages.create({
      body,
      from: process.env.SIGNALWIRE_PHONE_NUMBER,
      to: process.env.NOTIFY_SMS_NUMBER,
    });
    console.log("✅ SMS notification sent");
  } catch (err) {
    console.error("SMS send error:", err.message);
  }
}

// ─── SEND EMAIL ───────────────────────────────────────────────────────────────
async function sendEmail({ callerNumber, startTime, durationSeconds, gathered, transcriptText, driveLinks }) {
  const duration = `${Math.floor(durationSeconds / 60)}m ${durationSeconds % 60}s`;
  const time = new Date(startTime).toLocaleString("en-US", { timeZone: "America/New_York" });
  const formattedInfo = formatGathered(gathered);

  const subject = `📞 New Lead - ${gathered.name || callerNumber} | ${new Date(startTime).toLocaleDateString()}`;

  const text = [
    `New inbound call handled by Jordan (AI Assistant)`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `CALL DETAILS`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `Caller : ${callerNumber}`,
    `Time   : ${time} ET`,
    `Length : ${duration}`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `COLLECTED INFO`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    formattedInfo || "  (Nothing collected)",
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `GOOGLE DRIVE`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `Recording  : ${driveLinks?.recordingUrl  || "Not available"}`,
    `Transcript : ${driveLinks?.transcriptUrl || "Not available"}`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `FULL TRANSCRIPT`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    transcriptText || "(No transcript)",
    ``,
    `---`,
    `Sent by Buford Lawn Care AI Assistant`,
  ].join("\n");

  try {
    await transporter.sendMail({
      from: `"Buford Lawn Care AI" <${process.env.GMAIL_USER}>`,
      to: process.env.NOTIFY_EMAIL_ADDRESS,
      subject,
      text,
    });
    console.log("✅ Email notification sent");
  } catch (err) {
    console.error("Email send error:", err.message);
  }
}

// ─── MAIN EXPORT ──────────────────────────────────────────────────────────────
export async function sendNotifications(params) {
  await Promise.allSettled([
    sendSMS(params),
    sendEmail(params),
  ]);
}
