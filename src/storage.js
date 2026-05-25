import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";
import { Readable } from "stream";

// ─── SUPABASE CLIENT ──────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // Use service key (not anon) for server-side
);

// ─── GOOGLE DRIVE AUTH ────────────────────────────────────────────────────────
function getDriveClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  return google.drive({ version: "v3", auth });
}

// ─── UPLOAD TO GOOGLE DRIVE ───────────────────────────────────────────────────
export async function uploadToDrive({ callSid, callerNumber, recordingUrl, transcriptText, startTime }) {
  const drive = getDriveClient();
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

  const dateStr = new Date(startTime).toISOString().slice(0, 10); // YYYY-MM-DD
  const safeNumber = callerNumber.replace(/[^0-9]/g, "");
  const baseName = `${dateStr}_${safeNumber}_${callSid.slice(-6)}`;

  const links = {};

  // 1. Upload MP3 recording
  try {
    console.log(`📤 Downloading recording from Twilio: ${recordingUrl}`);

    // Twilio requires auth to download recordings
    const twilioAuth = Buffer.from(
      `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
    ).toString("base64");

    const audioResponse = await fetch(recordingUrl, {
      headers: { Authorization: `Basic ${twilioAuth}` },
    });

    if (!audioResponse.ok) throw new Error(`Twilio fetch failed: ${audioResponse.status}`);

    const audioBuffer = await audioResponse.buffer();
    const audioStream = Readable.from(audioBuffer);

    const audioFile = await drive.files.create({
      requestBody: {
        name: `${baseName}_recording.mp3`,
        parents: [folderId],
      },
      media: {
        mimeType: "audio/mpeg",
        body: audioStream,
      },
      fields: "id, webViewLink",
    });

    links.recordingUrl = audioFile.data.webViewLink;
    console.log(`✅ Recording uploaded to Drive: ${links.recordingUrl}`);
  } catch (err) {
    console.error("Drive recording upload error:", err.message);
  }

  // 2. Upload transcript as .txt
  try {
    const transcriptStream = Readable.from(Buffer.from(transcriptText, "utf-8"));

    const txtFile = await drive.files.create({
      requestBody: {
        name: `${baseName}_transcript.txt`,
        parents: [folderId],
      },
      media: {
        mimeType: "text/plain",
        body: transcriptStream,
      },
      fields: "id, webViewLink",
    });

    links.transcriptUrl = txtFile.data.webViewLink;
    console.log(`✅ Transcript uploaded to Drive: ${links.transcriptUrl}`);
  } catch (err) {
    console.error("Drive transcript upload error:", err.message);
  }

  return links;
}

// ─── SAVE TO SUPABASE ─────────────────────────────────────────────────────────
export async function saveToSupabase({
  call_sid,
  caller_number,
  start_time,
  end_time,
  duration_seconds,
  transcript,
  gathered_info,
  recording_drive_url,
  transcript_drive_url,
  recording_twilio_url,
}) {
  const { data, error } = await supabase.from("calls").insert([
    {
      call_sid,
      caller_number,
      start_time,
      end_time,
      duration_seconds,
      transcript,
      gathered_info, // JSONB column — stores the structured intake data
      recording_drive_url,
      transcript_drive_url,
      recording_twilio_url,
      created_at: new Date().toISOString(),
    },
  ]);

  if (error) {
    console.error("Supabase insert error:", error.message);
    return null;
  }

  console.log(`✅ Call saved to Supabase`);
  return data;
}
